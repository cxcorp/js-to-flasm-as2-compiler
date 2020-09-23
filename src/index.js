const babelParser = require("@babel/parser");
const { codeFrameColumns } = require("@babel/code-frame");
const uniq = require("lodash.uniq");
const fs = require("fs");

const A = `
function gatherStats(velocity) {
    var emptyLocal,
      emptyLocal2,
      nonEmptyLocal3;
    var localVar = 123;
    globalVar = 5432;

    globalVar = (localVar = 1111);
    globalVar = (globalVar2 = 1111);

    localVar = 'foobar';
    return '{"type":"velocity","data":' + velocity + '}'
}
enqueueStats(gatherStats(atvMC.velocity))
`;

const B = `
enqueueStats((function() {
    return '{"type":"velocity","data":' + atvMC.velocity + '}'
})())
`;

const code = A;

const INDENT_SPACES = 2;

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

let debugShit = "";

class Compiler {
  constructor({
    emitDeclarationComments,
    emitAssignmentComments,
    emitRegisterComments,
  }) {
    this._emitDeclarationComments = emitDeclarationComments;
    this._emitAssignmentComments = emitAssignmentComments;
    this._emitRegisterComments = emitRegisterComments;
  }

  _outputLines = [];
  _indent = 0;
  _sourceCode = "";
  // store registers here for other AST nodes
  _functionContext = [];

  generators = {
    FunctionDeclaration: (fnNode) => {
      // TODO: function closures - generate uniq names for globals for us to use?
      if (fnNode.id.type !== "Identifier") {
        this.throwNodeNotImplemented(fnNode.id);
      }

      const functionName = fnNode.id.name;
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
      fnNode.params.forEach((param) => {
        if (param.type !== "Identifier") {
          this.throwNodeNotImplemented(param);
        }
        registers.args[param.name] = registerAllocator.allocate(param.name);
      });

      if (fnNode.body.type !== "BlockStatement") {
        this.throwNodeNotImplemented(fnNode.body);
      }

      // Reserve registers for local variables
      uniq(
        fnNode.body.body
          .filter((node) => node.type === "VariableDeclaration")
          .flatMap((node) => {
            if (node.kind !== "var") {
              console.error(
                'Error: Only "var" variable declarations are supported'
              );
              this.throwNodeNotImplemented(node);
            }

            return node.declarations.map((declNode) => declNode.id.name);
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

      console.log(functionName, registers);

      debugShit += JSON.stringify(registers, null, 2);

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

      for (const bodyNode of fnNode.body.body) {
        this.print(bodyNode);
      }

      this.popFunctionContext();
      this.deindent();
      this.emit(`end // of function ${functionName}`);
    },
    VariableDeclaration: (declNode) => {
      if (this._emitDeclarationComments) {
        this.emitNodeSourceComment(declNode);
      }
      // can just print out the declarations - if we had different behavior for
      // var,let,const, we'd probably have stuff to do here
      for (const declaration of declNode.declarations) {
        this.print(declaration);
      }
    },
    VariableDeclarator: (declNode) => {
      const { id, init } = declNode;
      if (id.type !== "Identifier") this.throwNodeNotImplemented(id);
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

      console.log({ id, init });
    },
    NumericLiteral: (node) => {
      this.emit(`push ${node.value}`);
    },
    ExpressionStatement: (exprNode) => {
      this.print(exprNode.expression);
      this.emit("pop");
    },
    AssignmentExpression: (exprNode) => {
      if (this._emitAssignmentComments) {
        this.emitNodeSourceComment(exprNode);
      }
      const { left, operator, right } = exprNode;

      if (left.type !== "Identifier") {
        throw new CompilerError(
          `Left-side type "${left.type}" for operator "${exprNode.operator}" not implemented for node "${exprNode.type}"`,
          left
        );
      }

      // Assume "left" is variable
      const ctx = this.peekFunctionContext();
      const localVarRegister = ctx && ctx.getVariableRegister(left.name);

      if (!localVarRegister) {
        // If the variable is stored in a register, setRegister happens *after*
        // computing the value onto the stack.
        // If it's not a register variable, we need push the variable name
        // so we can setVariable after value is on stack.
        this.emit(`push '${left.name}'`);
      }

      switch (operator) {
        case "=": {
          // evaluate the right-side expression onto the stack
          this.print(right);
          break;
        }
        default: {
          throw new CompilerError(
            `Operator "${operator}" not implemented for node "${exprNode.type}"`,
            exprNode
          );
        }
      }

      // store result into left
      if (localVarRegister) {
        this.emit(`setRegister ${localVarRegister.toToken()}`);
      } else {
        // We need the result of the assignment to be on the stack in case
        // somebody is doing something with its return value - store the result
        // onto a temporary register and push it after setVariable since
        // setVariable eats the value
        if (!ctx) {
          // shit
          throw new CompilerError(
            `Using assignment expressions with non-local variables outside a function2 is not implemented!`,
            exprNode
          );
        }
        const tempRegister = ctx.allocTemporaryRegister();
        this.emit(`setRegister ${tempRegister.toToken()}`);
        this.emit("setVariable");
        this.emit(`push ${tempRegister.toToken()}`);
        ctx.freeTemporaryRegister(tempRegister);
      }
    },
  };

  compile(sourceCode) {
    this._sourceCode = sourceCode;
    const result = babelParser.parse(sourceCode);

    try {
      for (const body of result.program.body) {
        this.print(body);
      }
    } catch (e) {
      if (e instanceof CompilerError) {
        fs.writeFileSync(
          "./debug.lua",
          debugShit + "\n\n" + this._outputLines.join("\n"),
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
      this.throwNodeNotImplemented(node);
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

  pushFunctionContext(ctx) {
    return this._functionContext.push(ctx);
  }
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

  throwNodeNotImplemented(node) {
    throw new CompilerError(
      `Feature related to AST token "${node.type}" is not implemented in the compiler.`,
      node
    );
  }
}

new Compiler({
  emitDeclarationComments: true,
  emitAssignmentComments: true,
  emitRegisterComments: true,
}).compile(code);
