const Register = require("./register");

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

module.exports = RegisterAllocator;
