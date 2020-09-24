function maxBy(arr, fn) {
  return arr.reduce((max, val) => {
    const candidate = fn(val);
    return candidate > max ? candidate : max;
  }, 0);
}

function addStackSimulation(compilerOutput) {
  const rightpad =
    maxBy(compilerOutput, (line) =>
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

  return compilerOutput.map((op) => {
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

module.exports = addStackSimulation;
