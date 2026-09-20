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
  DetailPrint "Installing Cinba. This usually takes a few minutes."
  nsExec::ExecToLog '"$PLUGINSDIR\\CinbaBundle\\launcher\\cinba.exe" install --consume-bundle --failure-log "$PLUGINSDIR\\install-failure.txt"'
  Pop $0
  ${"$"}{If} $0 != 0
    StrCpy $1 "See the installation details for what failed."
    ClearErrors
    FileOpen $2 "$PLUGINSDIR\\install-failure.txt" r
    ${"$"}{IfNot} ${"$"}{Errors}
      FileRead $2 $3
      FileClose $2
      ${"$"}{If} $3 != ""
        StrCpy $1 $3
      ${"$"}{EndIf}
    ${"$"}{EndIf}
    MessageBox MB_ICONSTOP "Cinba installation failed (exit code $0).$\\r$\\n$\\r$\\n$1"
    SetErrorLevel 1
    Abort
  ${"$"}{EndIf}
SectionEnd
`;
}
