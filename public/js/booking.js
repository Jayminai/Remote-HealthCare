// Loads free time slots for the chosen date/doctor on the booking forms.
(function () {
  const form = document.querySelector('form[data-booking]');
  if (!form) return;
  const dateInput = form.querySelector('[name=date]');
  const doctorSelect = form.querySelector('[name=doctor_id]');
  const slotBox = form.querySelector('#slots');
  const message = form.querySelector('#slot-message');
  const selected = form.dataset.selectedTime || '';

  async function loadSlots() {
    slotBox.innerHTML = '';
    if (!dateInput.value) {
      message.textContent = 'Choose a date to see available times.';
      return;
    }
    message.textContent = 'Loading available times…';
    const params = new URLSearchParams({ date: dateInput.value });
    if (doctorSelect && doctorSelect.value) params.set('doctor_id', doctorSelect.value);
    try {
      const res = await fetch(`/api/slots?${params}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      message.textContent = data.message || `${data.slots.length} time(s) available. Times are West Africa Time.`;
      for (const slot of data.slots) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'time';
        input.value = slot.time;
        input.required = true;
        if (slot.time === selected) input.checked = true;
        label.title = `${slot.free} doctor(s) free`;
        label.append(input, document.createTextNode(slot.time));
        slotBox.append(label);
      }
    } catch (err) {
      message.textContent = 'Could not load times. Check your connection and try again.';
    }
  }

  dateInput.addEventListener('change', loadSlots);
  if (doctorSelect) doctorSelect.addEventListener('change', loadSlots);
  loadSlots();
})();
