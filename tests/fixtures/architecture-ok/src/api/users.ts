import { listUsers } from "../services/user-service";

export function usersHandler() {
  return listUsers();
}
