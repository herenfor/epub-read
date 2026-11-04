; Register as an EPUB candidate, never overwrite .epub's default or UserChoice.
; We intentionally do not use Tauri's APP_ASSOCIATE default-association macro.
!macro NSIS_HOOK_POSTINSTALL
  !if "${BUNDLEID}" == "dev.epubreader.app"
    !define SELIS_VISIBLE_NAME "SeLis"
    ; Keep PRODUCTNAME and UNINSTKEY for installer upgrades and old data paths.
    WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${SELIS_VISIBLE_NAME}"
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $R0
    ${If} $R0 == 1
      ${IfNot} ${FileExists} "$SMPROGRAMS\${SELIS_VISIBLE_NAME}.lnk"
        Rename "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$SMPROGRAMS\${SELIS_VISIBLE_NAME}.lnk"
      ${Else}
        !insertmacro IsShortcutTarget "$SMPROGRAMS\${SELIS_VISIBLE_NAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        Pop $R0
        ${If} $R0 == 1
          Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  !else
    !define SELIS_VISIBLE_NAME "${PRODUCTNAME}"
  !endif
  WriteRegStr SHCTX "Software\Classes\${BUNDLEID}.epub" "" "EPUB eBook"
  WriteRegStr SHCTX "Software\Classes\${BUNDLEID}.epub\DefaultIcon" "" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr SHCTX "Software\Classes\${BUNDLEID}.epub\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\.epub\OpenWithProgids" "${BUNDLEID}.epub" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${SELIS_VISIBLE_NAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".epub" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\${BUNDLEID}\Capabilities" "ApplicationName" "${SELIS_VISIBLE_NAME}"
  WriteRegStr SHCTX "Software\${BUNDLEID}\Capabilities" "ApplicationDescription" "EPUB eBook reader"
  WriteRegStr SHCTX "Software\${BUNDLEID}\Capabilities\FileAssociations" ".epub" "${BUNDLEID}.epub"
  WriteRegStr SHCTX "Software\RegisteredApplications" "${BUNDLEID}" "Software\${BUNDLEID}\Capabilities"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  !undef SELIS_VISIBLE_NAME
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !if "${BUNDLEID}" == "dev.epubreader.app"
    ${If} $UpdateMode <> 1
      !insertmacro IsShortcutTarget "$SMPROGRAMS\SeLis.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      Pop $R0
      ${If} $R0 == 1
        !insertmacro UnpinShortcut "$SMPROGRAMS\SeLis.lnk"
        Delete "$SMPROGRAMS\SeLis.lnk"
      ${EndIf}
    ${EndIf}
  !endif
  ; An old uninstaller must not unregister a newer installation at another path.
  ReadRegStr $R0 SHCTX "Software\Classes\${BUNDLEID}.epub\shell\open\command" ""
  StrCmp $R0 '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"' 0 epub_associations_done
    DeleteRegValue SHCTX "Software\Classes\.epub\OpenWithProgids" "${BUNDLEID}.epub"
    DeleteRegKey SHCTX "Software\Classes\${BUNDLEID}.epub"
    DeleteRegValue SHCTX "Software\RegisteredApplications" "${BUNDLEID}"
    DeleteRegKey SHCTX "Software\${BUNDLEID}\Capabilities"
    ReadRegStr $R0 SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" ""
    StrCmp $R0 '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"' 0 epub_associations_done
      DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  epub_associations_done:
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
