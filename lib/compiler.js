const babelParser = require("@babel/parser");
const { codeFrameColumns } = require("@babel/code-frame");
const fs = require("fs");

const addStackSimulation = require("./simulator");
const RegisterAllocator = require("./register-allocator");
/// <reference path="./context.d.ts" />
const Context = require("./context");

const INDENT_SPACES = 2;

const JS2F_DIRECTIVE = {
  // @js2f/push-register-context: r:1=this r:2=localVar1
  PushRegisterContext: "@js2f/push-register-context",
  // @js2f/pop-register-context
  PopRegisterContext: "@js2f/pop-register-context",
};

const JS2F_DIRECTIVES = new Set(Object.values(JS2F_DIRECTIVE));

class CompilerError extends Error {
  constructor(message, astNode) {
    super(message);
    this.astNode = astNode;
  }
}

/** Determines whether an AST node represents a literal that can be pushed directly with the push opcode. */
function isPushableLiteralNode(node) {
  // also .type === 'Identifier' && .name === 'undefined'
  return (
    node.type === "RegExpLiteral" ||
    node.type === "NullLiteral" ||
    node.type === "StringLiteral" ||
    node.type === "BooleanLiteral" ||
    node.type === "NumericLiteral" ||
    node.type === "BigIntLiteral" ||
    (node.type === "Identifier" && node.name === "undefined")
  );
}

class Compiler {
  constructor({
    emitStatementComments,
    emitAssignmentComments,
    emitRegisterComments,
    writeDebug,
  }) {
    this._emitStatementComments = emitStatementComments;
    this._emitAssignmentComments = emitAssignmentComments;
    this._emitRegisterComments = emitRegisterComments;
    this._writeDebug = writeDebug;
  }

  _outputLines = [];
  _indent = 0;
  _sourceCode = "";
  contexts = {
    /** @type {Context<Context.FunctionContext>} */
    function: new Context(),
    /** @type {Context<Context.RegisterVariablesContext} */
    registerVariables: new Context(),
    /** @type {Context<Context.LoopContext>} */
    loop: new Context(),

    /**
     * @argument {Array<[Context, any]>} contextList
     * @argument {() => void} fn
     */
    wrapMany: (contextList, fn) => {
      const combined = contextList.reduce((combinedFn, [ctx, ctxValue]) => {
        return () => ctx.wrap(ctxValue, combinedFn);
      }, fn);
      combined();
    },
  };

  generators = {
    FunctionDeclaration: (node) => {
      // TODO: function closures - generate uniq names for globals for us to use?
      const isExpression = node.id === null;
      if (node.id && node.id.type && node.id.type !== "Identifier") {
        throw new CompilerError(
          `Unknown node id type "${node.id.type}" in "${node.type}"`,
          node.id
        );
      }

      const functionName = !isExpression && node.id.name;
      const registerAllocator = new RegisterAllocator();

      const registers = {
        // this, _root, _parent, etc.
        meta: {
          this: registerAllocator.allocate("this"),
        },
        args: {},
        locals: {},
      };

      // Reserve registers for arguments
      node.params.forEach((param) => {
        this.assertImplemented(() => param.type === "Identifier", param);
        registers.args[param.name] = registerAllocator.allocate(param.name);
      });

      this.assertImplemented(
        () => node.body.type === "BlockStatement",
        node.body
      );

      const emitFunctionStart = () => {
        // Emit function start
        const stringifyRegisters = (regs) => {
          // sort by register number and stringify
          return Object.values(regs)
            .sort((a, b) => a.id - b.id)
            .map(({ id, name }) => (name ? `r:${id}='${name}'` : `r:${id}`))
            .join(", ");
        };

        const argsStr = stringifyRegisters(registers.args);
        const metaStr = stringifyRegisters(registers.meta);
        if (isExpression) {
          this.emit(`function2 (${argsStr}) (${metaStr})`);
        } else {
          this.emit(`function2 '${functionName}' (${argsStr}) (${metaStr})`);
        }
        // locals aren't declared in the prelude, their registers are just...used
      };

      emitFunctionStart();
      this.indent();

      // Bookkeeping object for variables declared so far so we can
      // emit an error if a variable gets double-declared
      const declaredVariables = {};

      this.contexts.wrapMany(
        [
          [
            this.contexts.function,
            {
              declareVariable: (id) => {
                const variableName = id.name;
                if (declaredVariables[variableName]) {
                  throw new CompilerError(
                    `Duplicate variable declaration for variable "${variableName}"`,
                    id
                  );
                }
                declaredVariables[variableName] = true;

                // Reserve register for local
                registers.locals[id.name] = registerAllocator.allocate(
                  undefined,
                  this._emitRegisterComments ? `local:${id.name}` : undefined
                );
              },
              allocTemporaryRegister: () =>
                registerAllocator.allocate(
                  undefined,
                  this._emitRegisterComments ? `temp` : undefined
                ),
              freeTemporaryRegister: (register) =>
                registerAllocator.free(register),
            },
          ],
          [
            this.contexts.registerVariables,
            {
              getVariableRegister: (variableName) => {
                // returns undefined if not a local
                return (
                  registers.locals[variableName] ||
                  registers.args[variableName] ||
                  registers.meta[variableName]
                );
              },
            },
          ],
        ],
        () => {
          this.print(node.body);
          this.deindent();

          if (isExpression) {
            this.emit("end");
          } else {
            this.emit(`end // of function ${functionName}`);
          }
        }
      );
    },
    BlockStatement: (node) => {
      for (const bodyNode of node.body) {
        this.print(bodyNode);
      }
    },
    VariableDeclaration: (node) => {
      if (this._emitStatementComments) {
        this.emitNodeSourceComment(node);
      }
      // TODO: investigate varEquals opcode

      if (node.kind !== "var") {
        throw new CompilerError(`Only "var" is supported at this time.`, node);
      }

      // can just print out the declarations - if we had different behavior for
      // var,let,const, we'd probably have stuff to do here
      for (const declaration of node.declarations) {
        this.print(declaration);
      }
    },
    VariableDeclarator: (node) => {
      const { id, init } = node;
      this.assertImplemented(() => id.type === "Identifier", id);
      const variableName = id.name;

      const fnCtx = this.contexts.function.peek();
      if (fnCtx) {
        // Inside a function - add name to bookkeeping and reserve
        // a register if we missed it on the initial pass
        // (e.g. was not a top-level variable)
        fnCtx.declareVariable(id);
      } else {
        // Nothing to do for globals since variables can be used freely
        // without adding their names into the constant pool
      }

      if (!init) {
        // No initializer
        return;
      }

      // Has initializer
      // Compile the init expression, should leave value on stack.
      this.print(init);

      // Variable in register?
      const register = this.contexts.registerVariables
        .peek()
        ?.getVariableRegister(variableName);
      if (register) {
        // We're inside a function and there's a register allocated for a
        // variable with this name -> store it into the right register
        this.emit(`setRegister ${register.toToken()}`);
        this.emit("pop");
        return;
      }

      // Global variable.
      throw new CompilerError(
        `Global variables not implemented for ${node.type}`,
        node
      );
    },
    NumericLiteral: (node) => {
      this.emit(`push ${node.value}`);
    },
    TemplateLiteral: (node) => {
      const { quasis } = node;
      const expressions = [...node.expressions];

      // strategy: iterate the quasis (the template string split by every
      // template value):
      // push the string literal to stack, evaluate its expression onto the stack
      // and add together
      // then add this new string to the accumulator string (empty string below)
      this.emit("push ''");

      for (const quasi of quasis) {
        const escapedValue = quasi.value.raw.replace(/'/g, "\\'");

        this.emit(`push '${escapedValue}'`);
        const expression = expressions.shift();

        // last string slice doesn't have a matching expression
        if (expression) {
          this.print(expression);
          this.emit("add");
        }
        this.emit("add");
      }
    },
    StringLiteral: (node) => {
      const escapes = [
        [/\x08/, "\\b"],
        [/\x0c/, "\\f"],
        [/\x0a/, "\\n"],
        [/\x0d/, "\\r"],
        [/\x09/, "\\t"],
      ];

      const escaped = escapes.reduce((str, [regex, replacement]) => {
        return str.replace(regex, replacement);
      }, node.value);

      this.emit(`push '${escaped}'`);
    },
    BooleanLiteral: (node) => {
      switch (node.value) {
        case true: {
          this.emit("push TRUE");
          return;
        }
        case false: {
          this.emit("push FALSE");
          return;
        }
        default:
          throw new CompilerError(
            `Value "${node.value}" not implemented in "${node.type}"`
          );
      }
    },
    Identifier: (node) => {
      const { name } = node;

      if (name === "undefined") {
        this.emit("push UNDEF");
        return;
      }

      const register = this.contexts.registerVariables
        .peek()
        ?.getVariableRegister(name);
      // local variable or arg, or otherwise found in register (i.e. declared
      // via directive)
      if (register) {
        this.emit(`push ${register.toToken()}`);
        return;
      }

      // global
      this.emit(`push '${name}'`);

      if (!node.__internalSkipGetMember) {
        this.emit("getVariable");
      }
    },
    IfStatement: (node) => {
      if (this._emitStatementComments) {
        this.emitNodeSourceComment(node.test, (testStr) => `if (${testStr})`);
      }
      const { test, consequent, alternate } = node;
      const labelId = Math.floor(Math.random() * 0xffffffff).toString(16);
      const labelTrue = `label_${labelId}_true`;
      const labelFalse = `label_${labelId}_false`;
      const labelEnd = `label_${labelId}_end`;

      this.print(test);
      this.emit("not");
      this.emit(`branchIfTrue ${labelFalse}`);
      this.withDeindent(() => this.emit(`${labelTrue}:`));
      // true
      if (consequent) {
        this.print(consequent);
      }
      this.emit(`branch ${labelEnd}`);
      // false
      this.withDeindent(() => this.emit(`${labelFalse}:`));
      if (alternate) {
        this.print(alternate);
      }
      this.withDeindent(() => this.emit(`${labelEnd}:`));
    },
    WhileStatement: (node) => {
      if (this._emitStatementComments) {
        this.emitNodeSourceComment(
          node.test,
          (testStr) => `while (${testStr})`
        );
      }

      const { test, body } = node;

      const labelId = Math.floor(Math.random() * 0xffffffff).toString(16);
      const labelLoopTest = `label_${labelId}_loop_test`;
      const labelLoopEnd = `label_${labelId}_loop_end`;

      this.contexts.loop.wrap(
        {
          emitBreak: () => {
            this.emit(`branch ${labelLoopEnd}`);
          },
        },
        () => {
          this.withDeindent(() => {
            this.emit(`${labelLoopTest}:`);
          });
          this.print(test);
          this.emit(`not`);
          this.emit(`branchIfTrue ${labelLoopEnd}`);

          this.print(body);
          this.emit(`branch ${labelLoopTest}`);

          this.withDeindent(() => {
            this.emit(`${labelLoopEnd}:`);
          });
        }
      );
    },
    BreakStatement: (node) => {
      if (this._emitStatementComments) {
        this.emitNodeSourceComment(node);
      }

      if (node.label !== null) {
        throw new CompilerError(
          `Labeled breaks are not implemented in "${node.type}"`,
          node
        );
      }

      const loopCtx = this.contexts.loop.peek();
      if (!loopCtx) {
        throw new CompilerError(`Can't use "break" outside a loop`, node);
      }

      loopCtx.emitBreak();
    },
    ReturnStatement: (node) => {
      if (this._emitStatementComments) {
        this.emitNodeSourceComment(node);
      }

      const { argument } = node;

      if (argument) {
        this.print(argument);
      } else {
        this.emit("push UNDEF");
      }
      this.emit("return");
    },
    ExpressionStatement: (node) => {
      if (this._emitStatementComments) {
        this.emitNodeSourceComment(node);
      }

      // HACK: Suggest to the expression node's AST visitor that we don't
      // really need the return value, so they can leave the stack clean.
      node.expression.__internalVoidExpressionOffered = true;

      this.print(node.expression);

      // HACK: Visitor accepted this and cleaned up the stack so we don't need
      // to.
      if (node.expression.__internalVoidExpressionAck) {
        return;
      }

      this.emit("pop");
    },
    AssignmentExpression: (node) => {
      if (this._emitAssignmentComments) {
        this.emitNodeSourceComment(node);
      }
      const { left, operator, right } = node;

      // Assume "left" is variable
      if (left.type !== "Identifier" && left.type !== "MemberExpression") {
        throw new CompilerError(
          `Left-side type "${left.type}" for operator "${node.operator}" not implemented for node "${node.type}"`,
          left
        );
      }

      const evaluateRight = () => {
        switch (operator) {
          case "=": {
            // evaluate the right-side expression onto the stack
            this.print(right);
            break;
          }
          default: {
            throw new CompilerError(
              `Operator "${operator}" not implemented for node "${node.type}"`,
              node
            );
          }
        }
      };

      const rightIsLiteral = isPushableLiteralNode(right);
      const ctx = this.contexts.function.peek();
      const leftRegister = this.contexts.registerVariables
        .peek()
        ?.getVariableRegister(left.name);

      if (leftRegister) {
        // Easy case - setRegister doesn't eat value from stack.
        evaluateRight();
        this.emit(`setRegister ${leftRegister.toToken()}`);

        if (node.__internalVoidExpressionOffered) {
          this.emit("pop");
          node.__internalVoidExpressionAck = true;
        }
        return;
      }

      const leftIsMemberExpression = left.type === "MemberExpression";
      const isInsideFunction = !!ctx;

      if (leftIsMemberExpression) {
        // HACK so MemberExpression doesn't call getExpression - maybe I'm just
        // implementing this poorly or JS differs from AS in this aspect.
        left.__internalSkipGetMember = true;
      }

      const evaluateLeft = () =>
        leftIsMemberExpression
          ? this.print(left)
          : this.emit(`push '${left.name}'`);
      // Code below assumes `emitAssignment` eats the evaluated value from the
      // stack.
      const emitAssignment = () =>
        leftIsMemberExpression
          ? this.emit("setMember")
          : this.emit("setVariable");

      if (node.__internalVoidExpressionOffered) {
        // Callee cleanup
        // A parent node has told us that they don't need the right value to be
        // on the stack.
        evaluateLeft();
        // Evaluate value onto stack
        evaluateRight();
        // Assign it
        emitAssignment();
        node.__internalVoidExpressionAck = true;
        return;
      }

      // CALLER CLEANUP
      // Since this is an expression, the value of the expression needs to be
      // present on the stack after we finish. The following blocks deal with
      // preserving the value, because setVariable and setMember eat the value.

      // A) Right is a literal which we can just `push` after assignment.
      // If it's not a literal, we don't want to re-evaluate it so we don't
      // get unexpected side-effects.
      if (rightIsLiteral) {
        evaluateLeft();
        evaluateRight();
        emitAssignment();
        evaluateRight();
        return;
      }

      // B) We're in a function so we can use the function's registers as
      // temporary registers
      if (isInsideFunction) {
        evaluateLeft();
        evaluateRight();

        const tempRegister = ctx.allocTemporaryRegister();
        this.emit(`setRegister ${tempRegister.toToken()}`);
        // store value
        emitAssignment();
        // push the value back onto the stack since we're in an expression
        this.emit(`push ${tempRegister.toToken()}`);
        ctx.freeTemporaryRegister(tempRegister);
        return;
      }

      // C) We're at the root so we can't use temporary function registers
      // borrow a global register, remember to restore afterwards
      this.emit("push r:1");
      evaluateLeft();
      evaluateRight();
      this.emit("setRegister r:1");
      emitAssignment();
      // Restore the borrowed global register
      this.emit("setRegister r:1");
    },
    BinaryExpression: (node) => {
      const { left, right, operator } = node;

      this.print(left);
      this.print(right);

      /*
        enum BinaryOperator {
          "==" | "!=" | "===" | "!=="
            | "<" | "<=" | ">" | ">="
            | "<<" | ">>" | ">>>"
            | "+" | "-" | "*" | "/" | "%"
            | "**" | "|" | "^" | "&" | "in"
            | "instanceof"
            | "|>"
        }
      */

      const operators = new Map(
        Object.entries({
          "==": "equals",
          // '!=': equals + not
          "===": "strictEquals",
          // '!==': strictEquals + not
          "<": "lessThan",
          // '<=': '>' + not
          ">": "greaterThan",
          // '>=': '<' + not
          "<<": "shiftLeft",
          ">>": "shiftRight",
          ">>>": "shiftRight2", // maybe?
          "+": "add",
          "-": "subtract",
          "*": "multiply",
          "/": "divide",
          "%": "modulo",
          // ** not impl
          "|": "bitwiseAnd",
          "^": "bitwiseXor",
          "&": "bitwiseOr",
          instanceof: "instanceOf",
        })
      );

      if (operators.has(operator)) {
        this.emit(operators.get(operator));
        return;
      }

      switch (operator) {
        case "!=":
          this.emit(operators.get("=="));
          this.emit("not");
          return;
        case "!==":
          this.emit(operators.get("==="));
          this.emit("not");
          return;
        case "<=":
          this.emit(operators.get(">"));
          this.emit("not");
          return;
        case ">=":
          this.emit(operators.get("<"));
          this.emit("not");
          return;
        default:
          throw new CompilerError(
            `Operator "${operator}" not implemented for "${node.type}"`,
            node
          );
      }
    },
    UnaryExpression: (node) => {
      const { operator, prefix, argument } = node;
      if (!prefix) {
        throw new CompilerError(
          `Unexpected prefix=false in "${node.type}"`,
          node
        );
      }

      switch (operator) {
        case "!": {
          this.print(argument);
          this.emit("not");
          return;
        }
        default: {
          throw new CompilerError(
            `Operator "${operator}" not implemented in "${node.type}"`,
            node
          );
        }
      }
    },
    UpdateExpression: (node) => {
      const { operator, argument, prefix } = node;
      if (argument.type !== "Identifier") {
        throw new CompilerError(
          `Argument type "${argument.type}" not implemented for ${node.type}`,
          node
        );
      }

      if (prefix) {
        throw new CompilerError(
          `Only postfix operations implemented in ${node.type}`,
          node
        );
      }

      const getOperationOpcode = () => {
        if (operator === "++") return "increment";
        if (operator === "--") return "decrement";
        throw new CompilerError(
          `Operator ${operator} not implemented for "${node.type}"`,
          node
        );
      };

      const register = this.contexts.registerVariables
        .peek()
        ?.getVariableRegister(argument.name);

      // identifier++
      if (register) {
        this.emit(`push ${register.toToken()}`);
        this.emit(getOperationOpcode());
        this.emit(`setRegister ${register.toToken()}`);
        return;
      }

      // not register variable
      this.emit(`push '${argument.name}'`);
      this.emit(`push '${argument.name}'`);
      this.emit("getVariable");
      this.emit(getOperationOpcode());
      this.emit("setVariable");
    },
    MemberExpression: (node) => {
      const { object, property, computed } = node;

      const pushObjectToStack = () => {
        switch (object.type) {
          case "Identifier": {
            const objectInRegister = this.contexts.registerVariables
              .peek()
              ?.getVariableRegister(object.name);

            if (objectInRegister) {
              this.emit(`push ${objectInRegister.toToken()}`);
            } else {
              this.emit(`push '${object.name}'`);
              this.emit("getVariable");
            }
            break;
          }
          case "NewExpression":
          case "MemberExpression":
          case "ThisExpression":
            this.print(object);
            break;
          default:
            throw new CompilerError(
              `Object type "${object.type}" not implemented in "${node.type}".`,
              object
            );
        }
      };

      pushObjectToStack();

      if (computed) {
        this.print(property);
      } else {
        if (property.type !== "Identifier") {
          throw new CompilerError(
            `Property type "${property.type}" not implemented for non-computed properties in "${node.type}".`,
            property
          );
        }

        this.emit(`push '${property.name}'`);
      }

      if (!node.__internalSkipGetMember) {
        this.emit("getMember");
      }
    },
    FunctionExpression: (node) => {
      // https://github.com/uxebu/flash8-swfparser/blob/7250fa9bfb0182536650692196f7568c4a0c86f4/src/main/java/com/jswiff/swfrecords/actions/DefineFunction2.java#L46
      // The difference between a function declaration and a function
      // expression is that a function expression doesn't specify a name.
      // A function2 without a name (an expression) is pushed to the stack,
      // whereas one with a name (a declaration) does no stack operations.

      // HACK: lol just discard id, replace root node with a
      // FunctionDeclaration and emit a FunctionDeclaration
      this.print({
        ...node,
        type: "FunctionDeclaration",
        id: null,
      });
    },
    ThisExpression: (node) => {
      const ctx = this.contexts.registerVariables.peek();
      if (!ctx) {
        throw new CompilerError(
          `"this" can only be used inside a function! If you know that "this" is defined in this context, define it with a "${JS2F_DIRECTIVE.PushRegisterContext}" directive.`,
          node
        );
      }

      const register = ctx.getVariableRegister("this");
      if (!register) {
        if (!this.contexts.function.peek()) {
          // We're inside a function context that we've defined ourselves,
          // but "this" is missing??
          throw new CompilerError(
            'Internal error. Expected "this" variable to have a register allocated!',
            node
          );
        }

        // Not in a function, but have register context -> maybe user has
        // declared registers?
        throw new CompilerError(
          `"this" used without declaring it with "${JS2F_DIRECTIVE.PushRegisterContext}"`,
          node
        );
      }

      this.emit(`push ${register.toToken()}`);
    },
    ArrayExpression: (node) => {
      const { elements } = node;

      /* Array expressions work like this:
       * 1. Push all elements to stack in reverse order
       * 2. Push array length to stack
       * 3. initArray
       */
      for (const elem of [...elements].reverse()) {
        this.print(elem);
      }
      this.emit(`push ${elements.length}`);
      this.emit("initArray");
    },
    NewExpression: (node) => {
      const { callee, arguments: args } = node;
      if (callee.type !== "Identifier") {
        throw new CompilerError(
          `Callee "${callee.type}" not implemented for "${node.type}"`,
          callee
        );
      }

      [...args].reverse().forEach((argNode) => {
        this.print(argNode);
      });

      this.emit(`push ${args.length}`);
      this.emit(`push '${callee.name}'`);
      this.emit(`new`);
    },
    CallExpression: (node) => {
      const { callee, arguments: args } = node;

      if (callee.type === "Identifier" && callee.name === "trace") {
        // Implementing would require us to notify caller somehow that
        // there's nothing to clean up from the stack. Maybe preprocess
        // AST and convert trace() calls into a custom node type?
        // Maybe a plugin for @babel/parser?
        throw new CompilerError(`"trace()" is not implemented.`, node);
      }

      // special handling for int() cast
      if (callee.type === "Identifier" && callee.name === "int") {
        if (args.length !== 1) {
          throw new CompilerError(
            `"int()" expects exactly one argument.`,
            node
          );
        }

        this.print(args[0]);
        this.emit("int");
        return;
      }

      [...args].reverse().forEach((argNode) => {
        this.print(argNode);
      });

      this.emit(`push ${args.length}`);
      callee.__internalSkipGetMember = true;
      this.print(callee);

      switch (callee.type) {
        case "Identifier":
          this.emit("callFunction");
          break;
        case "MemberExpression":
          this.emit("callMethod");
          break;
        default:
          throw new CompilerError(
            `Callee type "${callee.type}" not implemented in "${node.type}"`,
            callee
          );
      }
    },
  };

  optimize() {
    const pushOpcodeRgx = /^\s*push /;

    let i = 0;
    while (i < this._outputLines.length - 1) {
      const current = this._outputLines[i];
      const next = this._outputLines[i + 1];
      if (pushOpcodeRgx.test(current) && pushOpcodeRgx.test(next)) {
        // current opcode is a push, and the next one is a push -> merge them
        const newOpCode = current + ", " + next.replace(pushOpcodeRgx, "");
        this._outputLines[i] = newOpCode;
        this._outputLines.splice(i + 1, 1);
        // don't increment i - allows us to chain this same operation for all
        // following pushes
        continue;
      }
      i++;
    }
  }

  compile(sourceCode) {
    this._sourceCode = sourceCode;
    const result = babelParser.parse(sourceCode);

    try {
      for (const body of result.program.body) {
        this.print(body);
      }
      this.optimize();
      const lines = addStackSimulation(this._outputLines).join("\n");
      if (this._writeDebug) {
        fs.writeFileSync("./debug.lua", lines, "utf8");
      }
      return lines;
    } catch (e) {
      if (e instanceof CompilerError) {
        if (this._writeDebug && this._outputLines.length > 0) {
          this.optimize();
          fs.writeFileSync(
            "./debug.lua",
            addStackSimulation(this._outputLines).join("\n"),
            "utf8"
          );
        }

        console.error("Compiler error!");
        e.message += "\n" + codeFrameColumns(this._sourceCode, e.astNode.loc);
        throw e;
      }
      throw e;
    }
  }

  print(node) {
    this.parseAndExecuteJS2fDirectives(node.leadingComments);

    const generator = this.generators[node.type];
    if (!generator) {
      throw new CompilerError(`Node "${node.type}" is not implemented.`, node);
    }

    generator(node);

    this.parseAndExecuteJS2fDirectives(node.trailingComments);
  }

  parseJS2FDirectiveComments(comments) {
    const js2fDirectives = comments.flatMap((commentNode) => {
      // flatmap prunes these away
      const NOT_JS2F_DIRECTIVE = [];

      if (commentNode.type !== "CommentLine") {
        // only accept // comments
        return NOT_JS2F_DIRECTIVE;
      }
      // directive: arg1 arg2 arg3
      const value = splitAtFirst(commentNode.value.trim(), ":");

      const [directive, argsStr] = value;
      if (!JS2F_DIRECTIVES.has(directive)) {
        return NOT_JS2F_DIRECTIVE;
      }

      const args = argsStr?.trim().split(" ");
      return { directive, args, commentNode };
    });

    return js2fDirectives;
  }

  parseAndExecuteJS2fDirectives(comments) {
    if (!comments) {
      return;
    }

    const directives = this.parseJS2FDirectiveComments(comments);
    for (const directiveObj of directives) {
      const { directive, args, commentNode } = directiveObj;

      switch (directive) {
        case JS2F_DIRECTIVE.PushRegisterContext: {
          if (!args || args.length < 1) {
            throw new CompilerError(
              `Directive "${directive}" expects arguments!`,
              commentNode
            );
          }
          if (this.contexts.function.peek()) {
            throw new CompilerError(
              `Directive "${directive}" cannot be used inside a function!`,
              commentNode
            );
          }

          const declaredRegisters = args.map((arg) => {
            const [registerStr, variableName] = splitAtFirst(arg, "=");
            const [r, registerNumberStr] = registerStr.split(":");
            const registerNumber = parseInt(registerNumberStr, 10);

            if (r !== "r" || isNaN(registerNumber)) {
              throw new CompilerError(
                `Malformed "${directive}" argument "${arg}"`,
                commentNode
              );
            }
            if (variableName.includes("'") || variableName.includes('"')) {
              throw new CompilerError(
                `Quotes are not supported in "${directive}" arguments`,
                commentNode
              );
            }

            return { registerNumber, variableName };
          });

          const registers = {};
          const allocator = new RegisterAllocator();
          declaredRegisters.forEach(({ registerNumber, variableName }) => {
            if (registers[variableName]) {
              throw new CompilerError(
                `Variable "${variableName}" cannot be declared into two different registers with "${directive}"`,
                commentNode
              );
            }
            registers[variableName] = allocator.assign(
              registerNumber,
              undefined,
              `declared:${variableName}`
            );
          });

          this.contexts.registerVariables.push({
            getVariableRegister: (variableName) => registers[variableName],
          });
          return;
        }
        case JS2F_DIRECTIVE.PopRegisterContext: {
          if (!this.contexts.registerVariables.peek()) {
            throw new CompilerError(
              `Directive "${directive}" expects a matching "${JS2F_DIRECTIVE.PushRegisterContext}" directive!`,
              commentNode
            );
          }

          this.contexts.registerVariables.pop();
          return;
        }
      }
    }
  }

  indent() {
    this._indent += INDENT_SPACES;
  }

  deindent() {
    this._indent -= INDENT_SPACES;
    if (this._indent < 0) {
      console.warn(new Error("deindent() tried to make negative indent"));
      this._indent = 0;
    }
  }

  withDeindent(fn) {
    if (this._indent > 0) {
      this.deindent();
      fn();
      this.indent();
    } else {
      fn();
    }
  }

  emit(line) {
    if (!line) {
      throw new Error(`Attempted to emit falsy value "${line}"!`);
    }
    this._outputLines.push("".padStart(this._indent) + line);
  }

  emitNodeSourceComment(node, wrapperFn = (s) => s) {
    const src = this._sourceCode.slice(node.start, node.end);
    const isMultiline = src.includes("\n");

    if (isMultiline) {
      this.emit("/*--[[");
      this.emit(wrapperFn(src));
      this.emit("--]]*/");
      return;
    }

    this.emit(`//-- ${wrapperFn(src)}`);
  }

  assertImplemented(assertion, astNode) {
    if (!assertion()) {
      const e = new CompilerError(
        `Feature related to AST token "${astNode.type}" is not implemented in the compiler.`,
        astNode
      );
      e.original = new CompilerError(
        `Assertion "${assertion.toString()}" failed near node "${astNode.type}"`
      );
      throw e;
    }
  }

  throwNodeNotImplemented(node) {
    throw new CompilerError(
      `Feature related to AST token "${node.type}" is not implemented in the compiler.`,
      node
    );
  }
}

// like String.split but only splits at the first instance of the substring
// probably returns wonky stuff if substring is at the start or at the end
// but whatever, works for our use
function splitAtFirst(str, substr) {
  const index = str.indexOf(substr);
  if (index < 0) {
    return [str];
  }
  return [str.substring(0, index), str.substring(index + 1)];
}

module.exports = { Compiler, CompilerError };
