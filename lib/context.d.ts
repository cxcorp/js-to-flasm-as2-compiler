import Register from "./register";

class Context<T extends {}> {
  _contextStack: T[];

  wrap(contextValue: T, fn: () => {}): void;

  push(contextValue: T): number;

  pop(): T | undefined;

  peek(): T | undefined;

  assertWrapReturnNotPromise(val: any): any;
}

interface IdentifierNode {
  type: "Identifier";
  name: string;
  loc: any;
}

declare namespace Context {
  interface FunctionContext {
    declareVariable: (id: IdentifierNode) => void;
    getVariableRegister: (variableName: string) => Register | undefined;
    allocTemporaryRegister: () => Register;
    freeTemporaryRegister: (register: Register) => void;
    callSuper: (node: any) => void;
  }

  interface LoopContext {
    emitBreak: () => void;
  }

  interface RegisterVariablesContext {
    getVariableRegister: (variableName: string) => Register | undefined;
  }
}

export = Context;
