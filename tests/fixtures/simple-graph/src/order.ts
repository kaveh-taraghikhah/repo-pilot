import { charge } from "./payment";

export function placeOrder(amount: number): number {
  return charge(amount);
}
