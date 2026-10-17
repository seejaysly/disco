// Public settings for the Disco extension. Nothing here is secret:
// the publishable key and the Google client ID are meant to ship in client code.

export const SUPABASE_URL = 'https://rlvwfzhvbyuwtbnrqkou.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_7yDGFlDmZSnbcFI_sIrHsg_xntqgs7u';

// Google Cloud project "Disco", OAuth client used for Google sign-in.
// Its authorized redirect URIs must include chrome.identity.getRedirectURL(),
// which for this extension is https://ncnmnpcfeijaoohclhoneigipokhnpeo.chromiumapp.org/
export const GOOGLE_CLIENT_ID = '995846748554-vog5co77bjs8tfp0uvhsti2ouh86jitv.apps.googleusercontent.com';
