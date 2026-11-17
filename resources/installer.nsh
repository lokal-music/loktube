; Native LokTube setup. Builder retains extraction, registry and elevation logic.
!include nsDialogs.nsh
!include LogicLib.nsh

!define MUI_BGCOLOR "030509"
!define MUI_TEXTCOLOR "F0F5FF"
!define MUI_INSTFILESPAGE_COLORS "9CDDFF 071426"
!define MUI_CUSTOMFUNCTION_GUIINIT LokTubeGUIInit
!define MUI_FINISHPAGE_TITLE "$(LTReady)"
!define MUI_FINISHPAGE_TEXT "$(LTReadyText)"
!define MUI_FINISHPAGE_RUN_TEXT "$(LTLaunch)"

LangString LTTitle 1033 "Your videos. Your space."
LangString LTTitle 3082 "Tus videos. Tu espacio."
LangString LTTitle 1036 "Vos videos. Votre espace."
LangString LTIntro 1033 "A quieter home for YouTube, right on your desktop."
LangString LTIntro 3082 "Un hogar mas tranquilo para YouTube, en tu escritorio."
LangString LTIntro 1036 "Un espace plus calme pour YouTube, sur votre bureau."
LangString LTInstall 1033 "Install LokTube"
LangString LTInstall 3082 "Instalar LokTube"
LangString LTInstall 1036 "Installer LokTube"
LangString LTUpdate 1033 "Update LokTube"
LangString LTUpdate 3082 "Actualizar LokTube"
LangString LTUpdate 1036 "Mettre a jour LokTube"
LangString LTLocation 1033 "INSTALL LOCATION"
LangString LTLocation 3082 "CARPETA DE INSTALACION"
LangString LTLocation 1036 "EMPLACEMENT"
LangString LTChange 1033 "Change..."
LangString LTChange 3082 "Cambiar..."
LangString LTChange 1036 "Modifier..."
LangString LTChoose 1033 "Choose a folder for LokTube"
LangString LTChoose 3082 "Elige una carpeta para LokTube"
LangString LTChoose 1036 "Choisissez un dossier pour LokTube"
LangString LTKeep 1033 "Your accounts, library and settings stay in place."
LangString LTKeep 3082 "Tus cuentas, biblioteca y ajustes se conservan."
LangString LTKeep 1036 "Vos comptes, votre bibliotheque et vos reglages sont conserves."
LangString LTPrivate 1033 "Installed for you. Ready in a moment."
LangString LTPrivate 3082 "Instalado para ti. Listo en un momento."
LangString LTPrivate 1036 "Installe pour vous. Pret dans un instant."
LangString LTReady 1033 "Make yourself at home."
LangString LTReady 3082 "Estas en casa."
LangString LTReady 1036 "Bienvenue chez vous."
LangString LTReadyText 1033 "LokTube is ready. Open the app and pick something to watch."
LangString LTReadyText 3082 "LokTube esta listo. Abre la app y elige algo para ver."
LangString LTReadyText 1036 "LokTube est pret. Ouvrez l'application et choisissez une video."
LangString LTLaunch 1033 "Open LokTube"
LangString LTLaunch 3082 "Abrir LokTube"
LangString LTLaunch 1036 "Ouvrir LokTube"

!ifndef BUILD_UNINSTALLER
Var LTDialog
Var LTControl
Var LTPath
Var LTTitleFont
Var LTBrandFont
Var LTIcon
Var LTIconImage
Var LTExisting

; Skip the scope page, retaining existing scope and explicit command-line flags.
!macro customInstallMode
  ${IfNot} ${isForAllUsers}
  ${AndIfNot} ${isForCurrentUser}
    ${If} $hasPerMachineInstallation == "1"
    ${AndIf} $hasPerUserInstallation == "0"
      StrCpy $isForceMachineInstall "1"
    ${Else}
      StrCpy $isForceCurrentInstall "1"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  ; Capture detection before the scope hook changes Builder's selection flags.
  StrCpy $LTExisting "0"
  ${If} $hasPerUserInstallation == "1"
  ${OrIf} $hasPerMachineInstallation == "1"
    StrCpy $LTExisting "1"
  ${EndIf}
  InitPluginsDir
  File "/oname=$PLUGINSDIR\loktube.ico" "${BUILD_RESOURCES_DIR}\icon.ico"
!macroend

Function LokTubeGUIInit
  SetCtlColors $HWNDPARENT F0F5FF 030509
  GetDlgItem $0 $HWNDPARENT 1028
  SetCtlColors $0 9CDDFF 030509
FunctionEnd

!macro customPageAfterChangeDir
  Page custom LokTubeSetup
!macroend

Function LokTubeSetup
  ; In-app updates use /S; also skip any interactive --updated invocation.
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "LokTube ${VERSION}" "$(LTIntro)"
  nsDialogs::Create 1018
  Pop $LTDialog
  ${If} $LTDialog == error
    Abort
  ${EndIf}
  SetCtlColors $LTDialog F0F5FF 030509

  ${NSD_CreateIcon} 0u 4u 32u 32u ""
  Pop $LTIcon
  ${NSD_SetIcon} $LTIcon "$PLUGINSDIR\loktube.ico" $LTIconImage

  CreateFont $LTBrandFont "Segoe UI" 13 700
  ${NSD_CreateLabel} 42u 8u 250u 22u "LokTube"
  Pop $LTControl
  SendMessage $LTControl ${WM_SETFONT} $LTBrandFont 1
  SetCtlColors $LTControl 9CDDFF 030509

  CreateFont $LTTitleFont "Segoe UI" 21 600
  ${NSD_CreateLabel} 0u 47u 300u 32u "$(LTTitle)"
  Pop $LTControl
  SendMessage $LTControl ${WM_SETFONT} $LTTitleFont 1
  SetCtlColors $LTControl F0F5FF 030509

  ${NSD_CreateLabel} 0u 87u 300u 2u ""
  Pop $LTControl
  SetCtlColors $LTControl 1688FF 1688FF

  ${NSD_CreateLabel} 0u 104u 300u 12u "$(LTLocation)"
  Pop $LTControl
  SetCtlColors $LTControl 9CDDFF 030509
  ${NSD_CreateLabel} 0u 122u 238u 24u "$INSTDIR"
  Pop $LTPath
  SetCtlColors $LTPath F0F5FF 030509

  ; Existing installs keep their folder to avoid stranding shortcuts or metadata.
  ${If} $LTExisting == "1"
    ${NSD_CreateLabel} 0u 157u 300u 24u "$(LTKeep)"
    Pop $LTControl
    GetDlgItem $0 $HWNDPARENT 1
    ${NSD_SetText} $0 "$(LTUpdate)"
  ${Else}
    ${NSD_CreateButton} 244u 120u 56u 18u "$(LTChange)"
    Pop $LTControl
    ${NSD_OnClick} $LTControl LokTubeBrowse
    ${NSD_CreateLabel} 0u 157u 300u 24u "$(LTPrivate)"
    Pop $LTControl
    GetDlgItem $0 $HWNDPARENT 1
    ${NSD_SetText} $0 "$(LTInstall)"
  ${EndIf}
  SetCtlColors $LTControl A9B5C9 030509
  nsDialogs::Show
  ${NSD_FreeIcon} $LTIconImage
  System::Call 'gdi32::DeleteObject(p $LTTitleFont)'
  System::Call 'gdi32::DeleteObject(p $LTBrandFont)'
FunctionEnd

Function LokTubeBrowse
  nsDialogs::SelectFolderDialog "$(LTChoose)" "$INSTDIR"
  Pop $0
  ${If} $0 != error
  ${AndIf} $0 != ""
    ; Keep application files in a dedicated subfolder, like Builder's directory page.
    ${GetFileName} "$0" $1
    ${If} $1 == "LokTube"
      StrCpy $INSTDIR "$0"
    ${Else}
      StrCpy $INSTDIR "$0\LokTube"
    ${EndIf}
    ${NSD_SetText} $LTPath "$INSTDIR"
  ${EndIf}
FunctionEnd
!else
Function LokTubeGUIInit
  SetCtlColors $HWNDPARENT F0F5FF 030509
FunctionEnd
!endif
