function bar() {
  var x = 0;
  var acc = "";
  acc += x;
  acc += (x - 1) * 2 + "aaa";
  x += 1;

  global.bar += x;
  global.bar += (x - 1) * 2 + "aaa";
  global["no side effects here"] += "bbb";
  global[x + y] = "bar";
  ++bar;
}
