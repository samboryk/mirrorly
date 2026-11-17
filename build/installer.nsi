; Mirrorly — Windows installer (NSIS 3, Unicode)
Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!define APPNAME "Mirrorly"
!define APPEXE "Mirrorly.exe"
!ifndef VERSION
  !define VERSION "1.0.0"
!endif
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"

Name "${APPNAME}"
Caption "${APPNAME} ${VERSION} — встановлення"
OutFile "dist\Mirrorly-Setup-${VERSION}.exe"
InstallDir "$PROGRAMFILES64\${APPNAME}"
InstallDirRegKey HKLM "Software\${APPNAME}" "InstallDir"
RequestExecutionLevel admin
BrandingText "${APPNAME} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1058 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=1058 "FileDescription" "Встановлення ${APPNAME} — повтор екрана iPhone"
VIAddVersionKey /LANG=1058 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1058 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1058 "LegalCopyright" "© 2026 ${APPNAME}"

!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

Var IsUpdate

!define MUI_ICON "..\app\assets\icon.ico"
!define MUI_UNICON "..\app\assets\icon.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "welcome.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "welcome.bmp"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Mirrorly — повтор екрана iPhone на Windows"
!define MUI_WELCOMEPAGE_TEXT "Mirrorly перетворює цей комп’ютер на приймач AirPlay: на iPhone або iPad відкрийте Пункт керування, торкніться «Повтор екрана» й оберіть комп’ютер.$\r$\n$\r$\nПід час встановлення буде додано правило Брандмауера Windows, щоб iPhone у вашій локальній мережі міг знайти комп’ютер.$\r$\n$\r$\nНатисніть «Далі», щоб продовжити."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "Mirrorly встановлено"
!define MUI_FINISHPAGE_TEXT "Тепер на iPhone відкрийте Пункт керування → «Повтор екрана» й оберіть цей комп’ютер.$\r$\n$\r$\nОбидва пристрої мають бути в одній мережі Wi‑Fi."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Запустити Mirrorly"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Ukrainian"

Function LaunchApp
  ; start the app un-elevated (as the logged-in user), not as administrator
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\${APPEXE}"'
FunctionEnd

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Mirrorly потребує 64-розрядної Windows 10 або 11."
    Abort
  ${EndIf}
  SetRegView 64
  StrCpy $IsUpdate 0
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/UPDATE" $R1
  ${IfNot} ${Errors}
    StrCpy $IsUpdate 1
  ${EndIf}
FunctionEnd

Function .onInstSuccess
  ; after a silent self-update, start the new version for the logged-in user
  ${If} $IsUpdate == 1
    Exec '"$WINDIR\explorer.exe" "$INSTDIR\${APPEXE}"'
  ${EndIf}
FunctionEnd

Function un.onInit
  SetRegView 64
FunctionEnd

Section "Mirrorly (обов’язково)" SecMain
  SectionIn RO
  ; close a running copy so files can be replaced
  nsExec::Exec 'taskkill /F /IM "${APPEXE}" /T'
  Sleep 800
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"

  SetOutPath "$INSTDIR"
  File /r "dist\Mirrorly\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Windows Firewall: allow the receiver on the local network only (TCP 7000, mDNS, video/audio ports)
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${APPNAME}"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="${APPNAME}" dir=in action=allow program="$INSTDIR\${APPEXE}" enable=yes profile=any remoteip=localsubnet description="Mirrorly: приймання повтору екрана iPhone (AirPlay) у локальній мережі"'

  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortCut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${APPEXE}" "" "$INSTDIR\${APPEXE}" 0
  CreateShortCut "$SMPROGRAMS\${APPNAME}\Видалити ${APPNAME}.lnk" "$INSTDIR\Uninstall.exe"

  WriteRegStr HKLM "Software\${APPNAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayName" "${APPNAME} — повтор екрана iPhone"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTKEY}" "Publisher" "${APPNAME}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${APPEXE}"
  WriteRegStr HKLM "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoRepair" 1
  WriteRegDWORD HKLM "${UNINSTKEY}" "EstimatedSize" ${INSTALLED_KB}
SectionEnd

Section "Ярлик на робочому столі" SecDesktop
  ; on self-update keep the user's choice: only refresh an existing shortcut
  ${If} $IsUpdate == 1
  ${AndIfNot} ${FileExists} "$DESKTOP\${APPNAME}.lnk"
    Return
  ${EndIf}
  CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${APPEXE}" "" "$INSTDIR\${APPEXE}" 0
SectionEnd

LangString DESC_Main ${LANG_UKRAINIAN} "Програма Mirrorly та правило Брандмауера Windows для локальної мережі."
LangString DESC_Desktop ${LANG_UKRAINIAN} "Додати ярлик Mirrorly на робочий стіл."
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} $(DESC_Main)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} $(DESC_Desktop)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM "${APPEXE}" /T'
  Sleep 800
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${APPNAME}"'
  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APPNAME}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${UNINSTKEY}"
  DeleteRegKey HKLM "Software\${APPNAME}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APPNAME}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.${APPNAME}"
SectionEnd
