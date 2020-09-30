const Register = require("./register");

/**
 * Very simple register allocator for function2 registers. Stores allocated
 * registers in a Record<number, Register>. When allocating, it just iterates
 * 1 to 255 until a free slot is found. When freeing, just deletes property
 * at the records' id. Good enough for us for now.
 */
class RegisterAllocator {
  /** @type {{[id: number]: Register | undefined}} */
  _registers = {};

  /**
   * Allocates a register directly by ID. Throws if the register slot is
   * reserved.
   * @param {number} id
   * @param {string} name
   * @param {string} debugName
   */
  assign(id, name, debugName) {
    if (this._registers[id]) {
      throw new Error(`Register ${id} is already assigned!`);
    }

    this._registers[id] = new Register(id, name, debugName);
    return this._registers[id];
  }

  allocate(name, debugName) {
    // register r:1 through r:254 available inside function2
    // technically r:0 is available but flasm says:
    // > Registers are allocated by Flash Player in the above order, i.e the
    // > value of 'this' goes to r:1, the value of 'arguments' to r:2 etc.
    // > If 'this' is absent, 'arguments' goes to r:1. If you accidentally
    // > tell Flasm to store automatic values in wrong registers, Flasm will
    // > report an error.
    for (let i = 1; i <= 254; i++) {
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

module.exports = RegisterAllocator;
