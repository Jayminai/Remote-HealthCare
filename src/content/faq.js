// Questions and answers for the public FAQ page (and the short list on the home page).
// Keep answers in line with how the system actually behaves.

const FAQ_GROUPS = [
  {
    title: 'Booking and appointments',
    icon: 'fa-regular fa-calendar-check',
    items: [
      ['How do I book an appointment?',
        'Create a patient account, choose a video call, audio call or in-person visit, then pick a date and a free time slot. You will see the booking under "Appointments" straight away.'],
      ['Which consultation type should I choose?',
        'Video or audio calls suit follow-up visits, test results, mild illnesses, prescription renewals and health advice. Come in person if you need a physical examination, injection, dressing or laboratory test, or if your symptoms are severe.'],
      ['Can I choose my doctor?',
        'Yes, choosing a doctor is optional. If you leave it as "First available doctor", the least busy doctor who is free at that time is assigned.'],
      ['How do I cancel an appointment?',
        'Open "Appointments" and press Cancel next to a booked appointment. The slot is released so another patient can use it.'],
      ['Will I get a reminder?',
        'Yes. Reminders are sent 24 hours and 1 hour before your appointment, and on the morning of any follow-up date, in the app and by email.'],
    ],
  },
  {
    title: 'Consultations',
    icon: 'fa-solid fa-video',
    items: [
      ['How do I join a video or audio call?',
        'Sign in shortly before your appointment. A "Join consultation" button appears 15 minutes before the start time. Allow your browser to use your camera and microphone when asked.'],
      ['What if my internet connection is weak?',
        'Choose an audio call when booking. Audio needs far less data than video and works on most mobile networks.'],
      ['Can I get a prescription remotely?',
        'Yes, where it is appropriate. The prescription is added to your record and can be printed or shown at the pharmacy.'],
      ['What happens after the consultation?',
        'The diagnosis, notes and any prescription appear in "My record". If the doctor sets a follow-up, you get a reminder, and you can send the doctor a secure message with questions.'],
      ['Can I use this service for emergencies?',
        'No. For severe chest pain, difficulty breathing, heavy bleeding, loss of consciousness or any other emergency, go to the UHS emergency unit immediately.'],
    ],
  },
  {
    title: 'Records and privacy',
    icon: 'fa-solid fa-shield-heart',
    items: [
      ['Is my information private?',
        'Yes. Your data is handled in line with the Nigeria Data Protection Act 2023, every view or change of a record is written to an audit log, and sessions sign out automatically when idle.'],
      ['Who can see my medical record?',
        'You, the UHS doctors who treat you, and nurses and records staff for registration and vital signs. Administrators only see totals and statistics, never your notes.'],
      ['I already have a paper UHS folder. What should I do?',
        'Visit the records office with your ID card. They will digitise your folder and link it to an online account so you keep your history.'],
    ],
  },
  {
    title: 'Your account',
    icon: 'fa-regular fa-user',
    items: [
      ['Who can register?',
        'University of Ibadan students (with a matric number), staff (with a staff number) and registered dependants of staff.'],
      ['I forgot my password.',
        'Choose "Forgot your password?" on the sign-in page and enter your email address. We will email you a link to set a new password; it works once and expires after 1 hour. If you no longer use that email, visit the UHS records office.'],
      ['How do I update my phone number?',
        'Sign in and open your profile from your name at the top of the page. A correct phone number helps the clinic reach you.'],
    ],
  },
];

/** The four questions shown on the home page. */
const HOME_FAQS = [FAQ_GROUPS[0].items[0], FAQ_GROUPS[1].items[4], FAQ_GROUPS[1].items[0], FAQ_GROUPS[2].items[0]];

module.exports = { FAQ_GROUPS, HOME_FAQS };
