declare module "qrcode-terminal" {
  export function generate(
    text: string,
    opts: { small?: boolean },
    callback: (qr: string) => void,
  ): void;
  export function generate(
    text: string,
    callback: (qr: string) => void,
  ): void;
}
