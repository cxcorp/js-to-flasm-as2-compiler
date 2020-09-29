initializeSocketHook();

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

    globalXmlSocket.addEventListener("securityError", function foobar() {
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
}
