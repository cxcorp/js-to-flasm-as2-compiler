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

module.exports = Register;
