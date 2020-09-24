const babelParser = require("@babel/parser");
const { codeFrameColumns } = require("@babel/code-frame");
const uniq = require("lodash.uniq");
const fs = require("fs");

const A = `
outsideGlobalVar = globalVar2 = 123;

function gatherStats(velocity) {
  var emptyLocal, emptyLocal2, nonEmptyLocal3;
  var localVar = 123;
  globalVar = 5432;

  globalVar = localVar = 1111;
  globalVar = globalVar2 = 1111;
  globalVar = globalVar2 = undefined;

  velocity = atv.velocity;
  globalVelocity = atv.velocity;

  atv.bar = 1;
  this.foo = this.bar + 1;

  localVar = "foo\\nbar";
  return '{"type":"velocity","data":' + (velocity + 1) + "}";
}
enqueueStats(gatherStats(atvMC.velocity));
`;

const B = `
enqueueStats((function() {
    return '{"type":"velocity","data":' + atvMC.velocity + '}'
})())
`;

const code = A;

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

class Register {
  constructor(id, name, debugName) {
    this.id = id;
    this.name = name;
    this.debugName = debugName;
  }

  toToken() {
    return this.debugName
      ? `r:${this.name || this.id} /*${this.debugName}*/`
      : `r:${this.name || this.id}`;
  }
}

/**
 * Very simple register allocator for function2 registers. Stores allocated
 * registers in a Record<number, Register>. When allocating, it just iterates
 * 1 to 255 until a free slot is found. When freeing, just deletes property
 * at the records' id. Good enough for us for now.
 */
class RegisterAllocator {
  _registers = {};

  allocate(name, debugName) {
    // start from 1 because I don't want to touch r:0 in case it _is_ some
    // global register after all
    for (let i = 1; i < 255; i++) {
      if (this._registers[i]) {
        // Register reserved
        continue;
      }
      // Slot is free - take it.
      this._registers[i] = new Register(i, name, debugName);
      return this._registers[i];
    }

    throw new Error("Out of registers to allocate!");
  }

  /** @param {Register} register */
  free(register) {
    delete this._registers[register.id];
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
  }) {
    this._emitStatementComments = emitStatementComments;
    this._emitAssignmentComments = emitAssignmentComments;
    this._emitRegisterComments = emitRegisterComments;
  }

  _outputLines = [];
  _indent = 0;
  _sourceCode = "";
  // store registers here for other AST nodes
  _functionContext = [];

  generators = {
    FunctionDeclaration: (node) => {
      // TODO: function closures - generate uniq names for globals for us to use?
      this.assertImplemented(() => node.id.type === "Identifier", node.id);

      const functionName = node.id.name;
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

      // Reserve registers for local variables
      uniq(
        node.body.body
          .filter((n) => n.type === "VariableDeclaration")
          .flatMap((n) => {
            if (n.kind !== "var") {
              console.error(
                'Error: Only "var" variable declarations are supported'
              );
              this.throwNodeNotImplemented(n);
            }

            return n.declarations.map((declNode) => declNode.id.name);
          })
      ).forEach((varName) => {
        // deduplicate args, so just merge multiple "var foo", "var foo" into one
        registers.locals[varName] = registerAllocator.allocate(
          undefined,
          this._emitRegisterComments ? `local:${varName}` : undefined
        );
      });

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
        this.emit(`function2 ${functionName} (${argsStr}) (${metaStr})`);
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
      this.emit(`end // of function ${functionName}`);
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

      if (!init) {
        // Just a variable declaration
        if (fnCtx) {
          // Inside a function - just add name to bookkeeping
          fnCtx.declareVariable(id);
        }
        // In global scope - nothing to do since variables can be used freely
        // without adding their names into the constant pool
        return;
      }

      // Has initializer
      // Compile the init expression, should leave value on stack.
      this.print(init);

      // Local variable?
      const register = fnCtx && fnCtx.getVariableRegister(variableName);
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
    Identifier: (node) => {
      const { name } = node;

      if (name === "undefined") {
        this.emit("push UNDEF");
        return;
      }

      const ctx = this.peekFunctionContext();
      const register = ctx && ctx.getVariableRegister(name);
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
    ReturnStatement: (node) => {
      if (this._emitStatementComments) {
        this.emitNodeSourceComment(node);
      }
      const { argument } = node;

      this.print(argument);
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
      const leftIsRegister = !!(ctx && ctx.getVariableRegister(left.name));

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
      switch (operator) {
        case "+": {
          this.emit("add");
          break;
        }
        case "-": {
          this.emit("sub");
          break;
        }
        default:
          throw new CompilerError(
            `Operator "${operator}" not implemented for "${node.type}"`,
            node
          );
      }
    },
    MemberExpression: (node) => {
      if (node.computed) {
        throw new CompilerError(
          `Computed properties are not implemented for ${node.type}`,
          node
        );
      }

      const { object, property } = node;

      const ctx = this.peekFunctionContext();

      const pushObjectToStack = () => {
        switch (object.type) {
          case "Identifier": {
            const objectInRegister =
              ctx && ctx.getVariableRegister(object.name);

            if (objectInRegister) {
              this.emit(`push ${objectInRegister.toToken()}`);
            } else {
              this.emit(`push '${object.name}'`);
              this.emit("getVariable");
            }
            break;
          }
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
      this.emit(`push '${property.name}'`);

      if (!node.__internalSkipGetMember) {
        this.emit("getMember");
      }
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
      fs.writeFileSync(
        "./debug.lua",
        addStackSimulation(this._outputLines).join("\n"),
        "utf8"
      );
    } catch (e) {
      if (e instanceof CompilerError) {
        this.optimize();
        fs.writeFileSync(
          "./debug.lua",
          addStackSimulation(this._outputLines).join("\n"),
          "utf8"
        );

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

  emit(line) {
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

    this.emit(`//-- ` + src);
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

new Compiler({
  emitAssignmentComments: true,
  emitStatementComments: true,
  emitRegisterComments: true,
}).compile(code);

function maxBy(arr, fn) {
  return arr.reduce((max, val) => {
    const candidate = fn(val);
    return candidate > max ? candidate : max;
  }, 0);
}

function addStackSimulation(lines) {
  const rightpad =
    maxBy(lines, (line) =>
      /\s*(\/\/|\/\*|function2)/.test(line) ? 0 : line.length
    ) + 4;
  const stacks = [];
  let currentStack = 0;
  const stack = () => {
    if (!stacks[currentStack]) {
      stacks[currentStack] = [];
    }
    return stacks[currentStack];
  };
  const nextStack = () => {
    currentStack++;
  };
  const prevStack = () => {
    currentStack--;
  };
  const stringifyStack = () => "// " + (stack().join(" | ") || "--<empty>");

  const trimStartEndQuote = (str) =>
    str.startsWith("'") && str.endsWith("'")
      ? str.substring(1, str.length - 1)
      : str;

  const addSubAddParens = (operand) => {
    let leftParenSeen = false;
    for (let i = 0; i < operand.length; i++) {
      if ((operand[i] === "-" || operand[i] === "+") && !leftParenSeen) {
        return `(${operand})`;
      }
      if (operand[i] === "(") {
        leftParenSeen;
        continue;
      }
    }

    let rightParenSeen = false;
    for (let i = operand.length - 1; i >= 0; i--) {
      if ((operand[i] === "-" || operand[i] === "+") && !rightParenSeen) {
        return `(${operand})`;
      }
      if (operand[i] === ")") {
        rightParenSeen;
        continue;
      }
    }

    return operand;
  };
  let isInBlockComment = false;

  return lines.map((op) => {
    const paddedOp = op.padEnd(rightpad);
    const [opcode, ...others] = op.trim().split(" ");
    const opcodeArgs = others.join(" ");

    switch (opcode) {
      case "return": {
        if (stack().length > 1) {
          throw new Error(
            `Function returned with more than 1 value in stack! Stack was: // ${stringifyStack()}`
          );
        }
        return paddedOp + stringifyStack();
      }
      case "function2": {
        nextStack();
        return op;
      }
      case "end": {
        prevStack();
        return op;
      }
      case "push": {
        // split the push by the commas, ignoring commas inside strings
        // could be fixed by emitting metadata instead of literal strings, but meh
        const splits = [];
        let currentStringQuotes = null;

        let i = 0;
        while (i < opcodeArgs.length) {
          const c = opcodeArgs[i];
          const prevC = opcodeArgs[i - 1];
          const isEscaped = prevC === "\\";

          if (c === "," && !currentStringQuotes) {
            splits.push(i);
          }

          if (currentStringQuotes) {
            if (
              (c === '"' || c === "'") &&
              c === currentStringQuotes &&
              !isEscaped
            ) {
              currentStringQuotes = null;
            }
          } else {
            if (c === '"') currentStringQuotes = '"';
            if (c === "'") currentStringQuotes = "'";
          }

          i++;
        }
        const pushedArgs = splits.reverse().reduce(
          (parts, splitIndex) => {
            const str = parts.shift();
            parts.unshift(
              str.slice(0, splitIndex),
              // remove comma (and trailing space if present)
              str.slice(splitIndex + 1).replace(/^\s/, "")
            );
            return parts;
          },
          [opcodeArgs]
        );
        stack().push(...pushedArgs);
        return paddedOp + stringifyStack();
      }
      case "getVariable": {
        const varName = stack().pop();
        stack().push(trimStartEndQuote(varName));
        return paddedOp + stringifyStack();
      }
      case "getMember": {
        const property = stack().pop();
        const object = stack().pop();
        stack().push(`${object}.${trimStartEndQuote(property)}`);
        return paddedOp + stringifyStack();
      }
      case "callFunction": {
        const fnName = trimStartEndQuote(stack().pop());
        const argCount = parseInt(stack().pop(), 10);
        const args = stack().splice(stack().length - argCount);
        stack().push(`${fnName}(${args.reverse().join(", ")})`);
        return paddedOp + stringifyStack();
      }
      case "callMethod": {
        const fnName = trimStartEndQuote(stack().pop());
        const object = stack().pop();
        const argCount = parseInt(stack().pop(), 10);
        const args = stack().splice(stack().length - argCount);
        stack().push(`${object}.${fnName}(${args.reverse().join(", ")})`);
        return paddedOp + stringifyStack();
      }
      case "pop": {
        stack().pop();
        return paddedOp + stringifyStack();
      }
      case "setRegister": {
        return paddedOp + stringifyStack();
      }
      case "setVariable": {
        stack().pop();
        stack().pop();
        return paddedOp + stringifyStack();
      }
      case "setMember": {
        stack().pop();
        stack().pop();
        stack().pop();
        return paddedOp + stringifyStack();
      }
      case "add": {
        const right = addSubAddParens(stack().pop());
        const left = addSubAddParens(stack().pop());
        stack().push(`${left}+${right}`);
        return paddedOp + stringifyStack();
      }
      case "sub": {
        const right = addSubAddParens(stack().pop());
        const left = addSubAddParens(stack().pop());
        stack().push(`${left}-${right}`);
        return paddedOp + stringifyStack();
      }
      default: {
        if (op.trim().startsWith("/*")) {
          isInBlockComment = true;
          return op;
        }
        if (isInBlockComment && op.includes("*/")) {
          isInBlockComment = false;
          return op;
        }
        if (op.trim().startsWith("//")) {
          return op;
        }

        throw new Error(
          `Stack simulator encountered unimplemented opcode "${opcode}"`
        );
      }
    }
  });
}
