import { placeOrder } from "./order";

export function handleCheckout(amount: number): number {
  return placeOrder(amount);
}
