function handleEvent(x) {
  function handler() {}
  this.handler = handler;
  log(x);
}
atv.onEvent = handleEvent;
