import { getUser } from "../repositories/user";

export function usersHandler() {
  return getUser("1");
}
