// Example usage in your popup script

document.getElementById('loginButton').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'authenticate' }, (response) => {
    if (response.success) {
      // Use response.token in your API calls
      alert('Authenticated! Token: ' + response.token);
    } else {
      alert('Auth failed: ' + response.error);
    }
  });
});
