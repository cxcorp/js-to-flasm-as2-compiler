class Context {
  _contextStack = [];

  wrap(contextValue, fn) {
    this.push(contextValue);
    const ret = fn();
    this.assertWrapReturnNotPromise(ret);
    this.pop();
  }

  push(contextValue) {
    return this._contextStack.push(contextValue);
  }

  pop() {
    return this._contextStack.pop();
  }

  peek() {
    return this._contextStack.length > 0
      ? this._contextStack[this._contextStack.length - 1]
      : undefined;
  }

  assertWrapReturnNotPromise(val) {
    if (
      val &&
      typeof val.then === "function" &&
      val[Symbol.toStringTag] === "Promise"
    ) {
      throw new Error(`async functions cannot be used in "wrap"`);
    }
  }
}

module.exports = Context;
