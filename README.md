# js-to-flasm-as2-compiler

Compile (a subset of) JavaScript or AS2 to ActionScript 2 (Flash Player 8 compatible) bytecode assembly compilable by [Flasm](http://flasm.sourceforge.net/). Extremely WIP.

## Description

I'm modding an old Flash game and I got tired of writing ActionScript bytecode by hand. Luckily, ActionScript 2 is extremely similar to JavaScript (since AS2 partially conforms to the ECMAScript 4 spec) so I can just use [`@babel/parser`](https://babeljs.io/docs/en/babel-parser) to parse my source as JavaScript into an AST, and then emit the bytecode from the AST.

The compiler only supports a subset of JS/AS2 features I need, and the project reserves the right to butcher semantics of the language to make it easier to implement. Development will also progress only when I find features I want to implement to make my life easier.

The compiler also simulates the stack to document the current stack as comments to the right of each line to make manual verification easier. If a branch or branchIfTrue opcode is reached (an if-else or a loop), the simulator skips rest of the function/context. Inner functions are simulated with their own stacks. Code statements are also added as comments before the bytecode for said statement.

<!-- toc -->

- [Example](#example)
- [Usage](#usage)
- [Caveats and Flasm specific specials](#caveats-and-flasm-specific-specials)
- [Configuration](#configuration)
- [Compiler directives](#compiler-directives)
  * [`@js2f/push-register-context`, `@js2f/pop-register-context`](#js2fpush-register-context-js2fpop-register-context)
- [License](#license)

<!-- tocstop -->

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

global.enqueueStats(gatherStats(atvMC.velocity), 1);
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
function2 'gatherStats' (r:2='velocity') (r:1='this')
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
  subtract                                            // atv | 'x' | atv.velocityX-atv.x
  setMember                                           // --<empty>
  //-- localVar = "foo\\nbar";
  //-- localVar = "foo\\nbar"
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
//-- global.enqueueStats(gatherStats(atvMC.velocity), 1);
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

Clone the repo, and run `npm i`. Then, run `npm start`, or install it as a local relative npm module and run it as `js-to-flasm-as2-compiler` inside `package.json`

```
js-to-flasm-as2-compiler [configFilePath]
```

```sh
$ npm start

> js-to-flasm-as2-compiler@0.0.1 start D:\Projects\js-to-flasm-compiler
> node ./bin/index.js

samples\A.js -> dist\A.flm
samples\B.js -> dist\B.flm
empty file samples\Ca.js
samples\Caa.js -> dist\Caa.flm
samples\hooks\foobar\initialize-socket-hook.js -> dist\hooks\foobar\initialize-socket-hook.flm
```

If you're on Linux, you can probably just

```bash
chmod u+x bin/index.js
ln -s $PWD/bin/index.js ./js-to-flasm-as2-compiler
./js-to-flasm-as2-compiler
```

The compiler will compile the JS source files in `samples/`, and emit output to the `dist/` directory.

The compiler crashes if you use JS features that I haven't implemented.

The comments are also `//--` and `/*--[[ --]]*/` because Flasm's comments are `//` and `/* */`, but I use Lua's syntax highlighting for FLM (it's good enough!) and Lua's are `--` and `--[[ --]]`.

## Caveats and Flasm specific specials

- Only `var` is supported (no `let` or `const`)
  - Variables are scoped to the current function, or to the global scope
- `if` doesn't support logical binary operators
  - Logical expressions are not implemented (no `&&` or `||`), though `!` is
- `class` is not implemented, use prototype based programming (make a function that is a constructor and assign functions to Ctor.prototype)
- a lot of features are not implemented
  - feature list: see what compiles
- Use `int()` instead of `parseInt()`
  - so instead of `var foo = parseInt(bar)` do `var foo = int(bar)`
  - int's and parseInt's semantics probably differ, I don't know
  - compiles into the `int` opcode
- Computed properties only support side-effect free expressions
  - `foo[bar]` or `foo['bar']` or `foo[x + y + 1 + true + 0]` is okay, but `foo[bar++]` or `foo[selector()]` will fail to compile
  - I tried to implement it but it was nontrivial to implement
  - sorry
- Prefix increment/decrement operator is only implemented for variables, not member expressions
  - so `++variable` works but `++foo.bar` or `++foo[bar]` does not
  - no real blocker here, just haven't needed it and thus haven't taken the time to implement
- Postfix increment/decrement operator not implemented
  - `variable++` or `variable++` is not implemented
  - It's hard to implement with my current compiler design
  - Give me a break, it's the first compiler I've written

## Configuration

The compiler searches for a config file named `js-to-flasm.config.json` in the current directory, or from a path specified by the first argument passed to it.

E.g.

```
js-to-flasm-as2-compiler ./config/js-to-flasm.config.json
```

Example config file:

```json
{
  "dist": "dist/",
  "sourceRoot": "samples/"
}
```

No other keys are supported, and both are required. Both file paths can be anything that node's `fs.readdir()` understands. Terminating `/` is probably optional.

## Compiler directives

Compiler directives are implemented via single-line comments. Directives are not searched for inside block comments or JSDoc comments. A directive is of form:

```
// directive-name
```

or if it accepts arguments, it is of form:

```
// directive-with-args: arg1 arg2 arg3 argn
```

Current directives are:

### `@js2f/push-register-context`, `@js2f/pop-register-context`

Allows you to tell the compiler about register<->variable associations. For example, if you're compiling code that gets `#include`'d inside a function that you don't control (i.e. it's disassembled code), and you want to access `this` inside the function, you can instruct the compiler that it's in register n.

Pop the context once you don't need it anymore.

Example 1

```js
// @js2f/push-register-context: r:1=this
enqueueSocketJob('{"type": "cash", "data":' + this.cash + "}");
// @js2f/pop-register-context
```

Example 2

```js
// @js2f/push-register-context: r:3=socket
socket.onConnect = function () {
  // can use local variables here
  var foobar = 123;
};
// @js2f/pop-register-context
```

## License

MIT, see LICENSE.
