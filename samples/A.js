outsideGlobalVar = globalVar2 = 123;

function gatherStats(velocity) {
  var emptyLocal, emptyLocal2, nonEmptyLocal3;
  var localVar = 123;
  globalVar = 5432;

  var str0 = ``;
  var str1 = `hello world`;
  var str2 = `hello\n${localVar}`;
  var str3 = `${localVar}`;
  var str4 = `${localVar} asd`;
  var str5 = `hello ${localVar} = ${globalVar - fnResult("a")}, ${1}.`;

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
