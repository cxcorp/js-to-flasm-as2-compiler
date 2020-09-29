const babelParser = require("@babel/parser");
const { codeFrameColumns } = require("@babel/code-frame");
const uniq = require("lodash.uniq");
const fs = require("fs");

const addStackSimulation = require("./simulator");
const Register = require("./register");
const RegisterAllocator = require("./register-allocator");

const INDENT_SPACES = 2;

/**
 * @typedef {{
 *  declareVariable: (id: {type: string}) => void,
 *  getVariableRegister: (varName: string) => (Register | undefined),
 *  allocTemporaryRegister: () => Register,
 *  freeTemporaryRegister: (r: Register) => void
 * }} FunctionContext
 */

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
  // store registers here for other AST nodes
  _functionContext = [];
  // store context for loops here, such as emitBreak()
  _loopContext = [];

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

      this.pushFunctionContext({
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
        getVariableRegister: (variableName) => {
          // returns undefined if not a local
          return (
            registers.locals[variableName] ||
            registers.args[variableName] ||
            registers.meta[variableName]
          );
        },
        allocTemporaryRegister: () =>
          registerAllocator.allocate(
            undefined,
            this._emitRegisterComments ? `temp` : undefined
          ),
        freeTemporaryRegister: (register) => registerAllocator.free(register),
      });

      this.print(node.body);

      this.popFunctionContext();
      this.deindent();

      if (isExpression) {
        this.emit("end");
      } else {
        this.emit(`end // of function ${functionName}`);
      }
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

      const fnCtx = this.peekFunctionContext();
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

      // Local variable?
      const register = fnCtx?.getVariableRegister(variableName);
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

      const register = this.peekFunctionContext()?.getVariableRegister(name);
      // local variable or arg
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
        this.emitIfComment(node.test);
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
      const { test, body } = node;
      const labelId = Math.floor(Math.random() * 0xffffffff).toString(16);
      const labelLoopTest = `label_${labelId}_loop_test`;
      const labelLoopEnd = `label_${labelId}_loop_end`;

      this.pushLoopContext({
        emitBreak: () => {
          this.emit(`branch ${labelLoopEnd}`);
        },
      });

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

      this.popLoopContext();
    },
    BreakStatement: (node) => {
      if (node.label !== null) {
        throw new CompilerError(
          `Labeled breaks are not implemented in "${node.type}"`,
          node
        );
      }

      const loopCtx = this.peekLoopContext();
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
      const ctx = this.peekFunctionContext();
      const leftIsRegister = !!ctx?.getVariableRegister(left.name);

      if (leftIsRegister) {
        // Easy case - setRegister doesn't eat value from stack.
        evaluateRight();
        const register = ctx.getVariableRegister(left.name);
        this.emit(`setRegister ${register.toToken()}`);

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
    MemberExpression: (node) => {
      const { object, property, computed } = node;

      const pushObjectToStack = () => {
        switch (object.type) {
          case "Identifier": {
            const objectInRegister = this.peekFunctionContext()?.getVariableRegister(
              object.name
            );

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
      if (property.type !== "Identifier") {
        throw new CompilerError(
          `Property type "${property.type}" not implemented in "${node.type}".`,
          property
        );
      }

      if (computed) {
        this.print(property);
      } else {
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
      const ctx = this.peekFunctionContext();
      if (!ctx) {
        throw new CompilerError(
          '"this" can only be used inside a function',
          node
        );
      }

      const register = ctx.getVariableRegister("this");
      if (!register) {
        throw new CompilerError(
          'Internal error. Expected "this" variable to have a register allocated!',
          node
        );
      }

      this.emit(`push ${register.toToken()}`);
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
        if (this._writeDebug) {
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
    const generator = this.generators[node.type];
    if (!generator) {
      throw new CompilerError(`Node "${node.type}" is not implemented.`, node);
    }

    generator(node);
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

  /** @param {FunctionContext} ctx */
  pushFunctionContext(ctx) {
    return this._functionContext.push(ctx);
  }
  /** @returns {(FunctionContext | undefined)} */
  peekFunctionContext() {
    return this._functionContext.length > 0
      ? this._functionContext[this._functionContext.length - 1]
      : undefined;
  }
  popFunctionContext() {
    return this._functionContext.pop();
  }

  pushLoopContext(ctx) {
    return this._loopContext.push(ctx);
  }
  peekLoopContext() {
    return this._loopContext.length > 0
      ? this._loopContext[this._loopContext.length - 1]
      : undefined;
  }
  popLoopContext() {
    return this._loopContext.pop();
  }

  emit(line) {
    if (!line) {
      throw new Error(`Attempted to emit falsy value "${line}"!`);
    }
    this._outputLines.push("".padStart(this._indent) + line);
  }

  emitNodeSourceComment(node) {
    const src = this._sourceCode.slice(node.start, node.end);
    const isMultiline = src.includes("\n");

    if (isMultiline) {
      this.emit("/*--[[");
      this.emit(src);
      this.emit("--]]*/");
      return;
    }

    this.emit(`//-- ${src}`);
  }

  emitIfComment(test) {
    const src = this._sourceCode.slice(test.start, test.end);
    const isMultiline = src.includes("\n");

    if (isMultiline) {
      this.emit("/*--[[");
      this.emit(`if (${src}) {`);
      this.emit("--]]*/");
      return;
    }

    this.emit(`//-- if (${src}) {`);
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

module.exports = { Compiler, CompilerError };
