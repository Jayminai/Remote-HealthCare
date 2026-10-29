// Starts the embedded video/audio room and manages prescription rows.
(function () {
  const box = document.getElementById('video');
  if (box) {
    const { domain, room, name, audioOnly } = box.dataset;
    if (typeof window.JitsiMeetExternalAPI !== 'function') {
      box.innerHTML = '<div class="placeholder"><p>The video service could not be loaded. Check your internet connection, or use the "Open in new tab" link.</p></div>';
    } else {
      box.innerHTML = '';
      const api = new window.JitsiMeetExternalAPI(domain, {
        roomName: room,
        parentNode: box,
        width: '100%',
        height: '100%',
        userInfo: { displayName: name },
        configOverwrite: {
          prejoinPageEnabled: true,
          startWithVideoMuted: audioOnly === 'true',
          startAudioOnly: audioOnly === 'true',
          disableDeepLinking: true,
        },
        interfaceConfigOverwrite: { SHOW_JITSI_WATERMARK: false, MOBILE_APP_PROMO: false },
      });
      api.addListener('readyToClose', () => {
        box.innerHTML = '<div class="placeholder"><p>You have left the call.</p></div>';
      });
    }
  }

  // Prescription rows (doctor's consultation form).
  const rxList = document.getElementById('rx-list');
  const template = document.getElementById('rx-template');
  const addBtn = document.getElementById('rx-add');
  if (rxList && template && addBtn) {
    const add = () => rxList.append(template.content.cloneNode(true));
    addBtn.addEventListener('click', add);
    rxList.addEventListener('click', (e) => {
      if (e.target.matches('[data-remove-row]')) e.target.closest('.rx-row').remove();
    });
    if (!rxList.children.length) add();
  }
})();
