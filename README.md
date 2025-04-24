# 🕒 TimeTabler - Smart Timetable Generator

**TimeTabler** is a smart, web-based timetable generator designed to help educational institutions schedule classes more efficiently. It supports dynamic timetable creation, real-time editing, faculty absence handling, and exports in PDF, Word, and Excel formats. Built with flexibility in mind, TimeTabler allows different classes to have different schedules, start/end times, and lecture durations — all while minimizing conflicts and idle gaps.

---

## 🔧 Features

- 📅 **Dynamic Timetable Generation**  
  Automatically creates optimal weekly timetables based on user inputs like subject hours, faculty availability, and class constraints.

- ✏️ **Edit & Customize Timetables**  
  Modify any part of the timetable through an interactive editor with undo/redo and preview changes options.

- 🧑‍🏫 **Faculty Conflict Handling**  
  Ensures no faculty is double-booked and intelligently adjusts overlapping schedules.

- 🕐 **Different Start Times & Lecture Durations**  
  Supports varying schedules for different classes or days (e.g., 2nd year starts at 11:00 AM, 3rd year at 10:00 AM).

- 📉 **Idle Gap Optimization**  
  Tries to limit gaps to only 1 lecture per day per faculty, encouraging back-to-back lecture allocation.

- 💾 **Download Timetables**  
  Export timetables in multiple formats:  
  - PDF using `jsPDF`  
  - Word using `html-docx-js`  
  - Excel using `SheetJS`

- 💡 **Data-Driven Structure**  
  Stores timetable in JSON format to allow easy updates and future extensibility.

---



