export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required. Set it in server/.env.`);
  }

  return value;
}

export async function responseError(response: Response): Promise<string> {
  const body = await response.text();
  return `${response.status} ${response.statusText}${body ? `: ${body}` : ""}`;
}

