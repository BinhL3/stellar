export type BrowserMicrophone = Pick<MediaDeviceInfo, "deviceId" | "label">;

const toMicrophones = (devices: ReadonlyArray<MediaDeviceInfo>): BrowserMicrophone[] =>
  devices
    .filter((device) => device.kind === "audioinput")
    .map(({ deviceId, label }, index) => ({
      deviceId,
      label: label || `Microphone ${index + 1}`,
    }));

export async function listBrowserMicrophones(): Promise<BrowserMicrophone[]> {
  return toMicrophones(await navigator.mediaDevices.enumerateDevices());
}

/**
 * The microphones, and whether the page may read their names. Until microphone access is
 * granted, browsers blank the labels (and often the ids), so a saved device can't be matched.
 */
export async function listBrowserMicrophonesWithAccess(): Promise<{
  readonly microphones: BrowserMicrophone[];
  readonly named: boolean;
}> {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
    (device) => device.kind === "audioinput",
  );
  return {
    microphones: toMicrophones(devices).filter((device) => device.deviceId !== ""),
    named: devices.some((device) => device.label !== ""),
  };
}
