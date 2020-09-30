export = class Register {
  constructor(id: number, name: string, debugName?: string);

  id: number;
  name: string;
  debugName: string | undefined;

  toToken(): string;
};
