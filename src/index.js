const Compiler = require("./compiler");

const A = `
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
`;

const B = `
function handleEvent(x) {
  function handler() {
  }
  this.handler = handler;
  log(x);
}
atv.onEvent = handleEvent;
`;

const Ca = `
if (foo > 0) {
  console.log('aa')
}
console.log('bb')

if (foo > 0) {
  console.log('caa')
} else {
  console.log('cbb)
}
console.log('cc')

if (foo > 0) {
  console.log('>0')
} else if (foo >-5) {
  console.log('>-5')
} else {
  console.log('else')
}
console.log('outside')
`;

const Caa = `
function send(data, len) {
  if (len > 100) return;
  if (len == 100) return 100;
  if (len === 100) return 100;
  if (len != 100) return 100;
  if (len !== 1000) return 100;
  if (len <= 0) {
    return;
  }

  this.doSend(data, len);
}
`;

const C = `initializeSocketHook();

function sendSocketHookJobs() {
  var jobs = globalXmlSocketJobs.splice(0);
  if (jobs.length > 0) {
    globalXmlSocket.send("[" + jobs.join(",") + "]");
  }
}

function initializeSocketHook() {
  if (globalXmlSocket == undefined) {
    globalXmlSocketJobs = new Array();
    globalXmlSocket = new XMLSocket();

    globalXmlSocket.addEventListener("securityError", function foobar () {
      globalReplyData = new LoadVars();
      globalSendData = new LoadVars();
      globalSendData.status = "SECURITY_ERROR";
      globalSendData.sendAndLoad("/api/hello", globalReplyData, "POST");
    });

    globalXmlSocket.onClose = function tryReconnectGlobalXmlSocket() {
      clearInterval(tryReconnectGlobalXmlSocketInterval);
      if (!globalXmlSocket.connect("localhost", 10501)) {
        tryReconnectGlobalXmlSocketInterval = setInterval(
          tryReconnectGlobalXmlSocket,
          1000
        );
      }
    };

    globalXmlSocket.onConnect = function () {
      clearInterval(sendSocketHookJobsToken);
      sendSocketHookJobsToken = setInterval(sendSocketHookJobs, 200);
    };

    globalXmlSocket.connect("localhost", 10501);
  }
}`;

const code = C;

new Compiler({
  writeDebug: true,
  emitAssignmentComments: true,
  emitStatementComments: true,
  emitRegisterComments: true,
}).compile(code);
