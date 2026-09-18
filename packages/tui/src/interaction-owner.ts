export class InteractionOwner {
  #active: { cancel(): void } | undefined;

  replace(cancel: () => void): () => boolean {
    this.cancel();
    const interaction = { cancel };
    this.#active = interaction;
    return () => {
      if (this.#active === interaction) {
        this.#active = undefined;
        return true;
      }
      return false;
    };
  }

  cancel(): void {
    const active = this.#active;
    this.#active = undefined;
    active?.cancel();
  }
}
