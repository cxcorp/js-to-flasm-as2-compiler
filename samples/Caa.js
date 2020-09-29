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
