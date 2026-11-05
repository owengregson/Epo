/** Generation checks compare signal identity. Repeated reads of the same
 * driver/device pair must not manufacture a new generation. */
export class DriverSignal {
  private driver: AbortSignal | undefined;
  private device: AbortSignal | undefined;
  private combined: AbortSignal | undefined;

  get(driver: AbortSignal | undefined, device: AbortSignal): AbortSignal {
    if (this.driver !== driver || this.device !== device || this.combined === undefined) {
      this.driver = driver;
      this.device = device;
      this.combined = driver === undefined ? device : AbortSignal.any([driver, device]);
    }
    return this.combined;
  }
}
