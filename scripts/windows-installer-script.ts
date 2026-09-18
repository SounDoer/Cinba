function nsisDefine(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error("NSIS define values cannot contain control characters");
  }
  return value.replaceAll("$", "$$").replaceAll('"', '$\\"');
}

export function renderWindowsInstallerScript(options: {
  version: string;
  bundleDirectory: string;
  outputPath: string;
}): string {
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error("Windows installer requires a stable SemVer");
  }
  const bundle = nsisDefine(options.bundleDirectory);
  const output = nsisDefine(options.outputPath);
  return `Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"

Name "Cinba"
OutFile "${output}"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "Cinba ${options.version}"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$LOCALAPPDATA\\Programs\\Cinba\\desktop\\Cinba.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Cinba"
!define MUI_FINISHPAGE_RUN_CHECKED
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

Section "Install Cinba"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\\CinbaBundle"
  File /r "${bundle}\\*.*"
  ExecWait '"$PLUGINSDIR\\CinbaBundle\\launcher\\cinba.exe" install' $0
  ${"$"}{If} $0 != 0
    MessageBox MB_ICONSTOP "Cinba installation failed with exit code $0."
    SetErrorLevel $0
    Abort
  ${"$"}{EndIf}
SectionEnd
`;
}
