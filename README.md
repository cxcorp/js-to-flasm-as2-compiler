# js-to-flasm-as2-compiler

Compile (a subset of) JavaScript or AS2 to ActionScript 2 (Flash Player 8 compatible) bytecode assembly compilable by [Flasm](http://flasm.sourceforge.net/). Extremely WIP.

## Description

I'm modding an old Flash game and I got tired of writing ActionScript bytecode by hand. Luckily, ActionScript 2 is extremely similar to JavaScript (since AS2 partially conforms to the ECMAScript 4 spec) so I can just use [`@babel/parser`](https://babeljs.io/docs/en/babel-parser) to parse my source as JavaScript into an AST, and then emit the bytecode from the AST.

The compiler will only support a subset of JS/AS2 features I need, and the project reserves the right to butcher semantics of the language to make it easier to implement. Development will also progress only when I find features I want to implement to make my life easier.

## Example

Current work-in-progress sample source:

```js
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
```

Emits:

```lua
//-- outsideGlobalVar = globalVar2 = 123;
//-- outsideGlobalVar = globalVar2 = 123
push 'outsideGlobalVar'
//-- globalVar2 = 123
push 'globalVar2', 123
setVariable
push 123
setVariable
function2 gatherStats (r:2='velocity') (r:1='this')
  //-- var emptyLocal, emptyLocal2, nonEmptyLocal3;
  //-- var localVar = 123;
  push 123
  setRegister r:6 /*local:localVar*/
  pop
  //-- globalVar = 5432;
  //-- globalVar = 5432
  push 'globalVar', 5432
  setVariable
  //-- globalVar = localVar = 1111;
  //-- globalVar = localVar = 1111
  push 'globalVar'
  //-- localVar = 1111
  push 1111
  setRegister r:6 /*local:localVar*/
  setVariable
  //-- globalVar = globalVar2 = 1111;
  //-- globalVar = globalVar2 = 1111
  push 'globalVar'
  //-- globalVar2 = 1111
  push 'globalVar2', 1111
  setVariable
  push 1111
  setVariable
  //-- globalVar = globalVar2 = undefined;
  //-- globalVar = globalVar2 = undefined
  push 'globalVar'
  //-- globalVar2 = undefined
  push 'globalVar2', UNDEF
  setVariable
  push UNDEF
  setVariable
  //-- velocity = atv.velocity;
  //-- velocity = atv.velocity
  push 'atv'
  getVariable
  push 'velocity'
  getMember
  setRegister r:velocity
  pop
  //-- globalVelocity = atv.velocity;
  //-- globalVelocity = atv.velocity
  push 'globalVelocity', 'atv'
  getVariable
  push 'velocity'
  getMember
  setVariable
  //-- atv.bar = 1;
  //-- atv.bar = 1
  push 'atv'
  getVariable
  push 'bar', 1
  setMember
  //-- this.foo = this.bar + 1;
  //-- this.foo = this.bar + 1

  // <-- crashes here because I haven't implemented an AST node
```

## Usage

Clone the repo, and run `npm i`. Then, run `npm start` to start the code in watch mode. The compiler will compile source code inlined as a string in `src/index.js`, and emit output to a file named `debug.lua` in the root. The `lua` extension is there only because the syntax highlighting for Lua is good enough. The emitted file currently contains debug trash. The program will also crash but _that's fine_ - it's crashing so I know what AST node types I haven't implemented. The comments are also `//--` and `/*--[[ --]]*/` because Flasm's comments are `//` and `/* */`, but Lua's are `--` and `--[[ --]]`.

## License

MIT, see LICENSE.
