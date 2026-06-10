let sessionPassword = "";

export function setSessionPassword(password: string): void {
  sessionPassword = password;
}

export function getSessionPassword(): string {
  return sessionPassword;
}

