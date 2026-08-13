!include nsDialogs.nsh
!include LogicLib.nsh
!include WordFunc.nsh

!insertmacro VersionCompare

!ifndef BUILD_UNINSTALLER
  !macro customInit
    ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    ${If} $0 == ""
      ReadRegStr $0 HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    ${EndIf}
    ${If} $0 != ""
      ${VersionCompare} $0 "${VERSION}" $1
      ${If} $1 == 1
        ${IfNot} ${Silent}
          MessageBox MB_ICONSTOP|MB_OK "A newer version ($0) is already installed. Downgrades are not allowed."
        ${EndIf}
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
  !macroend
!endif

!ifdef BUILD_UNINSTALLER
  Var DataChoice
  Var KeepAllRadio
  Var RemoveCacheRadio
  Var RemoveAllRadio

  Function un.DataChoicePageCreate
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 28u "Choose what happens to application-owned data. User media and download directories are never changed."
    Pop $0
    ${NSD_CreateRadioButton} 0 36u 100% 12u "Keep all data (default)"
    Pop $KeepAllRadio
    ${NSD_CreateRadioButton} 0 56u 100% 12u "Remove caches, logs, and crash reports"
    Pop $RemoveCacheRadio
    ${NSD_CreateRadioButton} 0 76u 100% 12u "Remove all application-owned data"
    Pop $RemoveAllRadio
    ${NSD_Check} $KeepAllRadio
    StrCpy $DataChoice "keep"
    nsDialogs::Show
  FunctionEnd

  Function un.DataChoicePageLeave
    ${NSD_GetState} $RemoveAllRadio $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $DataChoice "all"
      MessageBox MB_ICONEXCLAMATION|MB_YESNO "Remove all application-owned data? User media and download directories remain untouched." IDYES done
      Abort
    ${EndIf}
    ${NSD_GetState} $RemoveCacheRadio $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $DataChoice "cache"
    ${Else}
      StrCpy $DataChoice "keep"
    ${EndIf}
    done:
  FunctionEnd

  !macro customUnInit
    ${GetParameters} $0
    ${GetOptions} $0 "/DATA=" $1
    ${IfNot} ${Errors}
      ${If} $1 == "cache"
        StrCpy $DataChoice "cache"
      ${ElseIf} $1 == "all"
        StrCpy $DataChoice "all"
      ${Else}
        StrCpy $DataChoice "keep"
      ${EndIf}
    ${Else}
      StrCpy $DataChoice "keep"
    ${EndIf}
  !macroend

  !macro customUnWelcomePage
    UninstPage custom un.DataChoicePageCreate un.DataChoicePageLeave
  !macroend

  !macro customUnInstall
    DeleteRegKey HKCU "Software\Classes\${APP_FILENAME}"
    ${If} $DataChoice == "cache"
      RMDir /r "$LOCALAPPDATA\${APP_FILENAME}\cache"
      RMDir /r "$LOCALAPPDATA\${APP_FILENAME}\logs"
      RMDir /r "$LOCALAPPDATA\${APP_FILENAME}\crashes"
    ${ElseIf} $DataChoice == "all"
      RMDir /r "$APPDATA\${APP_FILENAME}"
      RMDir /r "$LOCALAPPDATA\${APP_FILENAME}"
    ${EndIf}
  !macroend
!endif
