# js-to-flasm-as2-compiler

Compile (a subset of) JavaScript or AS2 to ActionScript 2 (Flash Player 8 compatible) bytecode assembly compilable by [Flasm](http://flasm.sourceforge.net/). Extremely WIP.

## Description

I'm modding an old Flash game and I got tired of writing ActionScript bytecode by hand. Luckily, ActionScript 2 is extremely similar to JavaScript (since AS2 partially conforms to the ECMAScript 4 spec) so I can just use [`@babel/parser`](https://babeljs.io/docs/en/babel-parser) to parse my source as JavaScript into an AST, and then emit the bytecode from the AST.

The compiler will only support a subset of JS/AS2 features I need, and the project reserves the right to butcher semantics of the language to make it easier to implement. Development will also progress only when I find features I want to implement to make my life easier.

The compiler also simulates the stack to document the current stack as comments to the right of each line to make manual verification easier. Code statements are also added as comments before the bytecode for said statement.

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
  atv.x = atv.velocityX - atv.x;

  localVar = "foo\\nbar";
  return '{"type":"velocity","data":' + (velocity + 1) + "}";
}

global.enqueueStats(gatherStats(atvMC.velocity), 1)
enqueueStats(gatherStats(atvMC.velocity));
emptyFunction();
global.emptyFunction();
```

Emits:

```lua
//-- outsideGlobalVar = globalVar2 = 123;
//-- outsideGlobalVar = globalVar2 = 123
push 'outsideGlobalVar'                               // 'outsideGlobalVar'
//-- globalVar2 = 123
push 'globalVar2', 123                                // 'outsideGlobalVar' | 'globalVar2' | 123
setVariable                                           // 'outsideGlobalVar'
push 123                                              // 'outsideGlobalVar' | 123
setVariable                                           // --<empty>
function2 gatherStats (r:2='velocity') (r:1='this')
  //-- var emptyLocal, emptyLocal2, nonEmptyLocal3;
  //-- var localVar = 123;
  push 123                                            // 123
  setRegister r:6 /*local:localVar*/                  // 123
  pop                                                 // --<empty>
  //-- globalVar = 5432;
  //-- globalVar = 5432
  push 'globalVar', 5432                              // 'globalVar' | 5432
  setVariable                                         // --<empty>
  //-- globalVar = localVar = 1111;
  //-- globalVar = localVar = 1111
  push 'globalVar'                                    // 'globalVar'
  //-- localVar = 1111
  push 1111                                           // 'globalVar' | 1111
  setRegister r:6 /*local:localVar*/                  // 'globalVar' | 1111
  setVariable                                         // --<empty>
  //-- globalVar = globalVar2 = 1111;
  //-- globalVar = globalVar2 = 1111
  push 'globalVar'                                    // 'globalVar'
  //-- globalVar2 = 1111
  push 'globalVar2', 1111                             // 'globalVar' | 'globalVar2' | 1111
  setVariable                                         // 'globalVar'
  push 1111                                           // 'globalVar' | 1111
  setVariable                                         // --<empty>
  //-- globalVar = globalVar2 = undefined;
  //-- globalVar = globalVar2 = undefined
  push 'globalVar'                                    // 'globalVar'
  //-- globalVar2 = undefined
  push 'globalVar2', UNDEF                            // 'globalVar' | 'globalVar2' | UNDEF
  setVariable                                         // 'globalVar'
  push UNDEF                                          // 'globalVar' | UNDEF
  setVariable                                         // --<empty>
  //-- velocity = atv.velocity;
  //-- velocity = atv.velocity
  push 'atv'                                          // 'atv'
  getVariable                                         // atv
  push 'velocity'                                     // atv | 'velocity'
  getMember                                           // atv.velocity
  setRegister r:velocity                              // atv.velocity
  pop                                                 // --<empty>
  //-- globalVelocity = atv.velocity;
  //-- globalVelocity = atv.velocity
  push 'globalVelocity', 'atv'                        // 'globalVelocity' | 'atv'
  getVariable                                         // 'globalVelocity' | atv
  push 'velocity'                                     // 'globalVelocity' | atv | 'velocity'
  getMember                                           // 'globalVelocity' | atv.velocity
  setVariable                                         // --<empty>
  //-- atv.bar = 1;
  //-- atv.bar = 1
  push 'atv'                                          // 'atv'
  getVariable                                         // atv
  push 'bar', 1                                       // atv | 'bar' | 1
  setMember                                           // --<empty>
  //-- this.foo = this.bar + 1;
  //-- this.foo = this.bar + 1
  push r:this, 'foo', r:this, 'bar'                   // r:this | 'foo' | r:this | 'bar'
  getMember                                           // r:this | 'foo' | r:this.bar
  push 1                                              // r:this | 'foo' | r:this.bar | 1
  add                                                 // r:this | 'foo' | r:this.bar+1
  setMember                                           // --<empty>
  //-- atv.x = atv.velocityX - atv.x;
  //-- atv.x = atv.velocityX - atv.x
  push 'atv'                                          // 'atv'
  getVariable                                         // atv
  push 'x', 'atv'                                     // atv | 'x' | 'atv'
  getVariable                                         // atv | 'x' | atv
  push 'velocityX'                                    // atv | 'x' | atv | 'velocityX'
  getMember                                           // atv | 'x' | atv.velocityX
  push 'atv'                                          // atv | 'x' | atv.velocityX | 'atv'
  getVariable                                         // atv | 'x' | atv.velocityX | atv
  push 'x'                                            // atv | 'x' | atv.velocityX | atv | 'x'
  getMember                                           // atv | 'x' | atv.velocityX | atv.x
  sub                                                 // atv | 'x' | atv.velocityX-atv.x
  setMember                                           // --<empty>
  //-- localVar = "foo\nbar";
  //-- localVar = "foo\nbar"
  push 'foo\nbar'                                     // 'foo\nbar'
  setRegister r:6 /*local:localVar*/                  // 'foo\nbar'
  pop                                                 // --<empty>
  //-- return '{"type":"velocity","data":' + (velocity + 1) + "}";
  push '{"type":"velocity","data":', r:velocity, 1    // '{"type":"velocity","data":' | r:velocity | 1
  add                                                 // '{"type":"velocity","data":' | r:velocity+1
  add                                                 // '{"type":"velocity","data":'+(r:velocity+1)
  push '}'                                            // '{"type":"velocity","data":'+(r:velocity+1) | '}'
  add                                                 // ('{"type":"velocity","data":'+(r:velocity+1))+'}'
  return                                              // ('{"type":"velocity","data":'+(r:velocity+1))+'}'
end // of function gatherStats
//-- global.enqueueStats(gatherStats(atvMC.velocity), 1)
push 1, 'atvMC'                                       // 1 | 'atvMC'
getVariable                                           // 1 | atvMC
push 'velocity'                                       // 1 | atvMC | 'velocity'
getMember                                             // 1 | atvMC.velocity
push 1, 'gatherStats'                                 // 1 | atvMC.velocity | 1 | 'gatherStats'
callFunction                                          // 1 | gatherStats(atvMC.velocity)
push 2, 'global'                                      // 1 | gatherStats(atvMC.velocity) | 2 | 'global'
getVariable                                           // 1 | gatherStats(atvMC.velocity) | 2 | global
push 'enqueueStats'                                   // 1 | gatherStats(atvMC.velocity) | 2 | global | 'enqueueStats'
callMethod                                            // global.enqueueStats(gatherStats(atvMC.velocity), 1)
pop                                                   // --<empty>
//-- enqueueStats(gatherStats(atvMC.velocity));
push 'atvMC'                                          // 'atvMC'
getVariable                                           // atvMC
push 'velocity'                                       // atvMC | 'velocity'
getMember                                             // atvMC.velocity
push 1, 'gatherStats'                                 // atvMC.velocity | 1 | 'gatherStats'
callFunction                                          // gatherStats(atvMC.velocity)
push 1, 'enqueueStats'                                // gatherStats(atvMC.velocity) | 1 | 'enqueueStats'
callFunction                                          // enqueueStats(gatherStats(atvMC.velocity))
pop                                                   // --<empty>
//-- emptyFunction();
push 0, 'emptyFunction'                               // 0 | 'emptyFunction'
callFunction                                          // emptyFunction()
pop                                                   // --<empty>
//-- global.emptyFunction();
push 0, 'global'                                      // 0 | 'global'
getVariable                                           // 0 | global
push 'emptyFunction'                                  // 0 | global | 'emptyFunction'
callMethod                                            // global.emptyFunction()
pop                                                   // --<empty>
```

## Usage

Clone the repo, and run `npm i`. Then, run `npm start` to start the code in watch mode. The compiler will compile source code inlined as a string in `src/index.js`, and emit output to a file named `debug.lua` in the root. The `lua` extension is there only because the syntax highlighting for Lua is good enough. The emitted file currently contains debug trash. The program will also crash but _that's fine_ - it's crashing so I know what AST node types I haven't implemented. The comments are also `//--` and `/*--[[ --]]*/` because Flasm's comments are `//` and `/* */`, but Lua's are `--` and `--[[ --]]`.

## License

MIT, see LICENSE.
