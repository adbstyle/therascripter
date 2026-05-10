on run argv
	set volumeName to item 1 of argv
	tell application "Finder"
		tell disk volumeName
			open
			delay 0.5
			set current view of container window to icon view
			set toolbar visible of container window to false
			set statusbar visible of container window to false
			set the bounds of container window to {400, 100, 940, 540}
			set viewOptions to the icon view options of container window
			set arrangement of viewOptions to not arranged
			set icon size of viewOptions to 110
			set text size of viewOptions to 12
			try
				set background picture of viewOptions to file ".background.tiff"
			end try
			delay 0.5
			update without registering applications
			delay 1.0
			close
		end tell
	end tell
end run
