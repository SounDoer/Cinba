import type { CoreProfile } from "./profiles.ts";

type ProfilePickerOption = {
  value: string;
  textContent: string | null;
};

export function syncProfilePicker<Option extends ProfilePickerOption>(
  currentOptions: Iterable<Option>,
  profiles: CoreProfile[],
  selectedProfileId: string,
  createOption: () => Option,
  replaceOptions: (options: Option[]) => void,
  selectProfile: (profileId: string) => void,
): void {
  const existing = new Map([...currentOptions].map((option) => [option.value, option]));
  replaceOptions(
    profiles.map((profile) => {
      const option = existing.get(profile.id) ?? createOption();
      option.value = profile.id;
      option.textContent = profile.label;
      return option;
    }),
  );
  selectProfile(selectedProfileId);
}
