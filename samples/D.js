vehicle.prototype.useFuel = function (amount) {
  this.fuel -= amount;

  var foo = (this.fuel -= amount);
};
