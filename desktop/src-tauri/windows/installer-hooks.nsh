!macro NSIS_HOOK_POSTINSTALL
  ; Keep an explicit marker beside the executable so custom install locations
  ; are recognized as installed builds instead of portable folders.
  FileOpen $0 "$INSTDIR\.video-similarity-install.json" w
  FileWrite $0 "{$\"layoutVersion$\":1,$\"managedBy$\":$\"Video Similarity NSIS$\"}$\r$\n"
  FileClose $0
!macroend
