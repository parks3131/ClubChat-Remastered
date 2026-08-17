Pod::Spec.new do |s|
  s.name           = 'ClubChatQuickLook'
  s.version        = '1.0.0'
  s.summary        = "Present a staged file in iOS's own document previewer."
  s.description    = "A local Expo module wrapping QLPreviewController, so a document sent in chat opens inside ClubChat rather than in another app."
  s.author         = 'ClubChat'
  s.homepage       = 'https://github.com/parks3131/ClubChat'
  s.license        = 'UNLICENSED'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
