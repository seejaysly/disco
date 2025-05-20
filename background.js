// Manifest V3 background service worker

const GOOGLE_CLIENT_ID = '1034066493115.apps.googleusercontent.com';
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets'
];

async function authenticateWithGoogle() {
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl =
    `https://accounts.google.com/o/oauth2/auth` +
    `?client_id=${GOOGLE_CLIENT_ID}` +
    `&response_type=token` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(GOOGLE_SCOPES.join(' '))}`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      {
        url: authUrl,
        interactive: true
      },
      function (redirectedTo) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (redirectedTo) {
          // Extract token from redirectedTo URL
          const match = redirectedTo.match(/[#&]access_token=([^&]+)/);
          if (match) {
            resolve(match[1]);
          } else {
            reject(new Error('No access token found'));
          }
        } else {
          reject(new Error('User did not complete login'));
        }
      }
    );
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'authenticate') {
    authenticateWithGoogle()
      .then(token => sendResponse({ success: true, token }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Indicates async response
  }
});
