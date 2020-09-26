const FLASM_KEYWORDS = require("./flasm-keywords.json");

const flasmKeywordsLookup = new Map(FLASM_KEYWORDS.map((word) => [word, true]));

function isFlasmKeyword(str) {
  return flasmKeywordsLookup.has(str);
}

class Register {
  constructor(id, name, debugName) {
    this.id = id;
    this.name = name;
    this.debugName = debugName;
  }

  toToken() {
    // flasm fails to parse if the name in r:name is a reserved keyword
    // seems to work if you enclose it in quotes
    const name =
      this.name && isFlasmKeyword(this.name) ? `'${this.name}'` : this.name;

    return this.debugName
      ? `r:${name || this.id} /*${this.debugName}*/`
      : `r:${name || this.id}`;
  }
}

module.exports = Register;
