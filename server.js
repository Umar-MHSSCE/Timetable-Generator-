const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const app = express();
const port = 3000;

// Import libraries for downloads
const PDFDocument = require('pdfkit');
const { Document, Packer, Paragraph, Table, TableRow, TableCell, WidthType, TextRun } = require('docx');
const ExcelJS = require('exceljs');

app.use(express.json());

app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

// Serve static files from the current directory
app.use(express.static(__dirname));

function getTimetableFilename(sessionID) {
  return `generated_timetable_${sessionID}.json`;
}

function loadTimetableFromFile(sessionID) {
  const filename = getTimetableFilename(sessionID);
  if (fs.existsSync(filename)) {
    return JSON.parse(fs.readFileSync(filename));
  }
  throw new Error('No timetable generated yet.');
}

/**
 * Helper function to normalize subject strings by removing whitespace
 * and converting to lowercase.
 */
function normalizeSubject(subject) {
  return subject.toLowerCase().replace(/\s+/g, '');
}

/**
 * Compare two subjects in a normalized manner.
 */
function subjectsMatch(subject1, subject2) {
  return normalizeSubject(subject1) === normalizeSubject(subject2);
}

// ----------------------
// Helper Functions
// ----------------------

// Shuffle an array using the Fisher-Yates algorithm.
function shuffleArray(array) {
  let arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Generate lecture slot timings from startTime to endTime while skipping breaks.
function generateSlotTimings(startTime, endTime, lectureDuration, breakTimes) {
  const slots = [];
  const lectureDurationMinutes = lectureDuration * 60;
  let currentTimeInMin =
    parseInt(startTime.split(':')[0]) * 60 + parseInt(startTime.split(':')[1]);
  const endTimeInMin =
    parseInt(endTime.split(':')[0]) * 60 + parseInt(endTime.split(':')[1]);

  const breaks = breakTimes.map(b => {
    return {
      start: parseInt(b.start.split(':')[0]) * 60 + parseInt(b.start.split(':')[1]),
      end: parseInt(b.end.split(':')[0]) * 60 + parseInt(b.end.split(':')[1])
    };
  }).sort((a, b) => a.start - b.start);

  let breakIndex = 0;
  while (currentTimeInMin + lectureDurationMinutes <= endTimeInMin) {
    if (
      breakIndex < breaks.length &&
      currentTimeInMin >= breaks[breakIndex].start &&
      currentTimeInMin < breaks[breakIndex].end
    ) {
      currentTimeInMin = breaks[breakIndex].end;
      breakIndex++;
      continue;
    }
    if (
      breakIndex < breaks.length &&
      currentTimeInMin < breaks[breakIndex].start &&
      currentTimeInMin + lectureDurationMinutes > breaks[breakIndex].start
    ) {
      currentTimeInMin = breaks[breakIndex].end;
      breakIndex++;
      continue;
    }
    const slotStart = currentTimeInMin;
    const slotEnd = currentTimeInMin + lectureDurationMinutes;
    slots.push({
      start: `${Math.floor(slotStart / 60).toString().padStart(2, '0')}:${(slotStart % 60).toString().padStart(2, '0')}`,
      end: `${Math.floor(slotEnd / 60).toString().padStart(2, '0')}:${(slotEnd % 60).toString().padStart(2, '0')}`
    });
    currentTimeInMin = slotEnd;
    if (breakIndex < breaks.length && currentTimeInMin === breaks[breakIndex].start) {
      currentTimeInMin = breaks[breakIndex].end;
      breakIndex++;
    }
  }
  return slots;
}

// Create a blank timetable object for every class, day, and lecture slot.
function createBlankTimetables(classes, days, slotTimings) {
  const timetable = {};
  classes.forEach(cls => {
    timetable[cls.className] = {};
    days.forEach(day => {
      timetable[cls.className][day] = slotTimings.map(slot => ({
        time: slot,
        lecture: null
      }));
    });
  });
  return timetable;
}

// Initialize resource availability (for faculties, rooms, labs) as arrays of 0's.
function initializeAvailability(resources, days, totalSlots) {
  const availability = {};
  resources.forEach(resource => {
    availability[resource] = {};
    days.forEach(day => {
      availability[resource][day] = Array(totalSlots).fill(0);
    });
  });
  return availability;
}

// Assign labs to practical subjects using a round-robin random approach.
function assignLabsToSubjects(classes, labs) {
  let subjectToLabMapping = {};
  let practicalSubjectsSet = new Set();
  classes.forEach(cls => {
    cls.practicalSubjects.forEach(subject => {
      practicalSubjectsSet.add(normalizeSubject(subject));
    });
  });
  const subjectsArray = Array.from(practicalSubjectsSet);
  let labPool = labs.slice();
  subjectsArray.forEach(subject => {
    if (labPool.length === 0) {
      labPool = labs.slice();
    }
    const randomIndex = Math.floor(Math.random() * labPool.length);
    subjectToLabMapping[subject] = labPool[randomIndex];
    labPool.splice(randomIndex, 1);
  });
  return subjectToLabMapping;
}

// Helper function to choose the best faculty for a given slot based on compactness.
function findBestFacultyForSlot(candidateFaculties, day, slotIndex, facultyAvailability) {
  let bestFaculty = null;
  let bestScore = Infinity;

  candidateFaculties.forEach(faculty => {
    const schedule = facultyAvailability[faculty.facultyName][day];

    if ((slotIndex > 0 && schedule[slotIndex - 1] === 1) ||
      (slotIndex < schedule.length - 1 && schedule[slotIndex + 1] === 1)) {
      bestFaculty = faculty;
      bestScore = 0;
      return;
    }

    let minGap = Infinity;
    for (let i = 0; i < schedule.length; i++) {
      if (schedule[i] === 1) {
        const gap = Math.abs(i - slotIndex);
        if (gap < minGap) {
          minGap = gap;
        }
      }
    }

    if (minGap < bestScore) {
      bestScore = minGap;
      bestFaculty = faculty;
    }
  });

  return bestFaculty;
}

// Revised Timetable Generation Logic with Relaxed Compact Scheduling
function generateTimetable(
  timetable,
  facultyAvailability,
  roomAvailability,
  labAvailability,
  classes,
  faculties,
  slotTimings,
  days,
  lectureDuration,
  maxFacultyLecturesPerDay,
  maxSubjectLecturesPerDay,
  subjectToLabMapping = null
) {
  const roomKeys = Object.keys(roomAvailability);
  let fixedRoomMapping = {};
  if (classes.length === roomKeys.length || classes.length <= roomKeys.length) {
    classes.forEach((cls, index) => {
      fixedRoomMapping[cls.className] = roomKeys[index];
    });
  }
  const labsArray = Object.keys(labAvailability);
  if (!subjectToLabMapping) {
    subjectToLabMapping = assignLabsToSubjects(classes, labsArray);
  }

  // const subjectToLabMapping = assignLabsToSubjects(classes, labsArray);

  classes.forEach(cls => {
    days.forEach(day => {
      for (let slot = 0; slot < slotTimings.length; slot++) {
        if (timetable[cls.className][day][slot].lecture !== null) continue;

        const allSubjects = cls.theorySubjects.concat(cls.practicalSubjects);
        const subjectsToTry = shuffleArray(allSubjects);
        let assigned = false;

        for (const subject of subjectsToTry) {
          const subjectAssignedCount = timetable[cls.className][day].filter(
            slotObj => slotObj.lecture && subjectsMatch(slotObj.lecture.subject, subject)
          ).length;
          if (subjectAssignedCount >= maxSubjectLecturesPerDay) continue;

          const subjectKey = Object.keys(cls.subjectWeeklyHours).find(key =>
            subjectsMatch(key, subject)
          );
          if (!subjectKey || cls.subjectWeeklyHours[subjectKey] < lectureDuration) continue;

          const candidateFaculties = faculties.filter(faculty => {
            const canTeach =
              faculty.theorySubjects.some(fs => subjectsMatch(fs, subject)) ||
              faculty.practicalSubjects.some(fs => subjectsMatch(fs, subject));
            if (!canTeach) return false;
            if (facultyAvailability[faculty.facultyName][day][slot] !== 0) return false;
            const dailyWorkload = facultyAvailability[faculty.facultyName][day].filter(s => s === 1).length;
            return dailyWorkload < maxFacultyLecturesPerDay;
          });

          let selectedFaculty = null;
          if (candidateFaculties.length > 0) {
            selectedFaculty = findBestFacultyForSlot(candidateFaculties, day, slot, facultyAvailability);
          }
          if (!selectedFaculty && candidateFaculties.length > 0) {
            selectedFaculty = candidateFaculties[0];
          }

          if (!selectedFaculty) {
            console.warn(`No available faculty for subject ${subject} in class ${cls.className} on ${day} at slot ${slot}.`);
            continue;
          }

          let availableResource = null;
          const isPractical = cls.practicalSubjects.some(ps => subjectsMatch(ps, subject));
          if (isPractical) {
            const normalizedSubject = normalizeSubject(subject);
            const assignedLab = subjectToLabMapping[normalizedSubject];
            if (!assignedLab || labAvailability[assignedLab][day][slot] !== 0) {
              console.warn(`Assigned lab ${assignedLab} for practical subject ${subject} in class ${cls.className} is not available on ${day} at slot ${slot}.`);
              continue;
            }
            availableResource = assignedLab;
          } else {
            if (Object.keys(fixedRoomMapping).length > 0) {
              availableResource = fixedRoomMapping[cls.className];
              if (roomAvailability[availableResource][day][slot] !== 0) {
                console.warn(`Fixed room ${availableResource} for class ${cls.className} is not available on ${day} at slot ${slot}.`);
                continue;
              }
            } else {
              availableResource = Object.keys(roomAvailability).find(
                room => roomAvailability[room][day][slot] === 0
              );
              if (!availableResource) {
                console.warn(`No available room for theory subject ${subject} in class ${cls.className} on ${day} at slot ${slot}.`);
                continue;
              }
            }
          }

          timetable[cls.className][day][slot].lecture = {
            subject,
            faculty: selectedFaculty.facultyName,
            venue: availableResource,
            time: timetable[cls.className][day][slot].time
          };

          facultyAvailability[selectedFaculty.facultyName][day][slot] = 1;
          if (isPractical) {
            labAvailability[availableResource][day][slot] = 1;
          } else {
            roomAvailability[availableResource][day][slot] = 1;
          }

          cls.subjectWeeklyHours[subjectKey] -= lectureDuration;
          assigned = true;
          break;
        }

        if (!assigned) {
          console.warn(`No available subject/faculty could be assigned for class ${cls.className} on ${day} at slot ${slot}.`);
        }
      }
    });
  });

  return { timetable, subjectToLabMapping };

}

// ----------------------
// Global variable for submitted data storage
// ----------------------
let submittedData = null;

// Endpoint to receive timetable input data from client
app.post('/submitData', (req, res) => {
  req.session.submittedData = req.body;
  // console.log("Received Data:", req.session.submittedData);
  res.json({ message: "Data submitted successfully!" });
});

// Endpoint to generate and return the timetable.
app.get('/generateTimetable', (req, res) => {
  if (!req.session.submittedData) {
    return res.status(400).json({ error: "No data submitted yet." });
  }

  const {
    department,
    classes,
    faculties,
    startTime,
    endTime,
    lectureDuration,
    breakTimes,
    maxFacultyLecturesPerDay,
    maxSubjectLecturesPerDay,
    numberOfRooms,
    numberOfLabs,
    saturdayEnabled,
    saturdayStartTime,
    saturdayEndTime,
    saturdayBreakTimes
  } = req.session.submittedData;

  let days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const slotTimings = generateSlotTimings(startTime, endTime, lectureDuration, breakTimes);
  if (slotTimings.length <= 0) {
    return res.status(400).json({
      error: 'No valid lecture slots could be generated. Check your timings and breaks.'
    });
  }

  const timetable = createBlankTimetables(classes, days, slotTimings);
  const totalSlots = slotTimings.length;
  const facultyAvailability = initializeAvailability(
    faculties.map(f => f.facultyName),
    days,
    totalSlots
  );

  const rooms = Array.from({ length: numberOfRooms }, (_, i) => `Room${i + 1}`);
  const labs = Array.from({ length: numberOfLabs }, (_, i) => `Lab${i + 1}`);
  const roomAvailability = initializeAvailability(rooms, days, totalSlots);
  const labAvailability = initializeAvailability(labs, days, totalSlots);

  const result = generateTimetable(
    timetable,
    facultyAvailability,
    roomAvailability,
    labAvailability,
    classes,
    faculties,
    slotTimings,
    days,
    lectureDuration,
    maxFacultyLecturesPerDay,
    maxSubjectLecturesPerDay
  );
  const generatedTimetable = result.timetable;
  const subjectToLabMapping = result.subjectToLabMapping;

  let saturdayNeeded = false;
  if (saturdayEnabled) {
    saturdayNeeded = true;
  } else {
    classes.forEach(cls => {
      for (let subj in cls.subjectWeeklyHours) {
        if (cls.subjectWeeklyHours[subj] > 0) {
          saturdayNeeded = true;
        }
      }
    });
  }

  if (saturdayNeeded) {
    let satStart = (saturdayEnabled && saturdayStartTime) ? saturdayStartTime : startTime;
    let satEnd = (saturdayEnabled && saturdayEndTime) ? saturdayEndTime : endTime;
    const saturdaySlots = generateSlotTimings(satStart, satEnd, lectureDuration,
      (saturdayBreakTimes && saturdayBreakTimes.length > 0) ? saturdayBreakTimes : breakTimes);

    faculties.forEach(faculty => {
      facultyAvailability[faculty.facultyName]['Saturday'] = Array(saturdaySlots.length).fill(0);
    });
    Object.keys(roomAvailability).forEach(room => {
      roomAvailability[room]['Saturday'] = Array(saturdaySlots.length).fill(0);
    });
    Object.keys(labAvailability).forEach(lab => {
      labAvailability[lab]['Saturday'] = Array(saturdaySlots.length).fill(0);
    });

    classes.forEach(cls => {
      generatedTimetable[cls.className]['Saturday'] = saturdaySlots.map(slot => ({
        time: slot,
        lecture: null
      }));
    });

    generateTimetable(
      generatedTimetable,
      facultyAvailability,
      roomAvailability,
      labAvailability,
      classes,
      faculties,
      saturdaySlots,
      ['Saturday'],
      lectureDuration,
      maxFacultyLecturesPerDay,
      maxSubjectLecturesPerDay,
      subjectToLabMapping,
      subjectToLabMapping
    );
    days.push('Saturday');
  }

  // Build additional timetables: facultyTimetable and resourceTimetable
  const facultyTimetable = {};
  faculties.forEach(faculty => {
    facultyTimetable[faculty.facultyName] = {};
  });
  const resourceTimetable = {};
  rooms.forEach(room => {
    resourceTimetable[room] = {};
  });
  labs.forEach(lab => {
    resourceTimetable[lab] = {};
  });

  for (const className in generatedTimetable) {
    for (const day in generatedTimetable[className]) {
      generatedTimetable[className][day].forEach(slotObj => {
        if (slotObj.lecture) {
          const timeLabel = `${slotObj.time.start} - ${slotObj.time.end}`;
          const { subject, faculty, venue } = slotObj.lecture;
          if (!facultyTimetable[faculty][day]) {
            facultyTimetable[faculty][day] = {};
          }
          facultyTimetable[faculty][day][timeLabel] = `${subject} - ${className}`;

          if (!resourceTimetable[venue]) {
            resourceTimetable[venue] = {};
          }
          if (!resourceTimetable[venue][day]) {
            resourceTimetable[venue][day] = {};
          }
          resourceTimetable[venue][day][timeLabel] = `${subject} - ${className} - ${faculty}`;
        }
      });
    }
  }

  const output = {
    department,
    classes,
    faculties,
    startTime,
    endTime,
    lectureDuration,
    breakTimes,
    maxFacultyLecturesPerDay,
    maxSubjectLecturesPerDay,
    numberOfRooms,
    numberOfLabs,
    saturdayEnabled,
    saturdayStartTime,
    saturdayEndTime,
    saturdayBreakTimes,
    timetable: generatedTimetable,
    facultyTimetable,
    resourceTimetable
  };
  

  // Store the generated timetable in session for download endpoints.
  req.session.generatedTimetable = output;

  const filename = `generated_timetable_${req.sessionID}.json`;
  fs.writeFile(filename, JSON.stringify(output, null, 2), err => {
    if (err) {
      console.error('Error writing timetable to file:', err);
    } else {
      console.log(`Timetable successfully saved to ${filename}`);
    }
  });

  res.json(output);
});

// ----------------------
// Download Endpoints
// ----------------------

// Utility: Build table data from the generated timetable (for the main timetable only).
// We iterate over each class in timetable and for each class, we assume all days have the same number of slots.
function buildTableData(timetable) {
  let tables = []; // one per class
  for (let className in timetable) {
    const classTable = { className, header: [], rows: [] };
    const fixedDayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const days = fixedDayOrder.filter(day => timetable[className].hasOwnProperty(day));

    classTable.header = ['Time', ...days];
    // Determine maximum number of slots among days.
    let maxSlots = 0;
    days.forEach(day => {
      maxSlots = Math.max(maxSlots, timetable[className][day].length);
    });
    for (let i = 0; i < maxSlots; i++) {
      let row = [];
      // Use first day's slot for time if available.
      if (timetable[className][days[0]][i]) {
        row.push(`${timetable[className][days[0]][i].time.start} - ${timetable[className][days[0]][i].time.end}`);
      } else {
        row.push('');
      }
      days.forEach(day => {
        if (timetable[className][day][i]) {
          const lecture = timetable[className][day][i].lecture;
          if (lecture) {
            row.push(`${lecture.subject}\n${lecture.faculty}\n${lecture.venue}`);
          } else {
            row.push('');
          }
        } else {
          row.push('');
        }
      });
      classTable.rows.push(row);
    }
    tables.push(classTable);
  }
  return tables;
}

// PDF Download: Generate timetable tables in PDF.
app.get('/download/pdf', (req, res) => {
  try {
    const timetableData = loadTimetableFromFile(req.sessionID);
    const tables = buildTableData(timetableData.timetable);

    res.setHeader('Content-Disposition', 'attachment; filename="timetable.pdf"');
    res.setHeader('Content-Type', 'application/pdf');

    const doc = new PDFDocument({ margin: 30, size: 'A4' });
    doc.pipe(res);

    doc.fontSize(18).text('Timetable', { align: 'center' }).moveDown();

    let isFirst = true;

    tables.forEach(table => {
      if (!isFirst) {
        doc.addPage(); // Start new page for each class
      }
      isFirst = false;

      doc.fontSize(14).text(`Class: ${table.className}`, { underline: true }).moveDown(0.5);

      const startX = 50;
      let currentY = doc.y;
      const rowHeight = 50;
      const timeColumnWidth = 80;
      const totalWidth = doc.page.width - 100;
      const otherColumnWidth = (totalWidth - timeColumnWidth) / (table.header.length - 1);

      // Draw header row
      let offset = 0;
      table.header.forEach((header, i) => {
        const colWidth = i === 0 ? timeColumnWidth : otherColumnWidth;
        doc.rect(startX + offset, currentY, colWidth, rowHeight).stroke();
        doc.fontSize(10).text(header, startX + offset + 5, currentY + 12, {
          width: colWidth - 10,
          align: 'center'
        });
        offset += colWidth;
      });
      currentY += rowHeight;

      // Draw data rows
      table.rows.forEach(row => {
        offset = 0;
        row.forEach((cell, i) => {
          const colWidth = i === 0 ? timeColumnWidth : otherColumnWidth;
          doc.rect(startX + offset, currentY, colWidth, rowHeight).stroke();
          doc.fontSize(9).text(cell, startX + offset + 4, currentY + 8, {
            width: colWidth - 8,
            align: 'center'
          });
          offset += colWidth;
        });
        currentY += rowHeight;

        // Add new page if close to bottom
        if (currentY > doc.page.height - 100) {
          doc.addPage();
          currentY = 50;
        }
      });

      doc.moveDown(2);
    });

    doc.end();

  } catch (error) {
    res.status(500).send(error.message);
  }
});


// Word Download: Generate timetable tables in a Word document.
app.get('/download/word', async (req, res) => {
  try {
    const timetableData = loadTimetableFromFile(req.sessionID);
    const tables = buildTableData(timetableData.timetable);

    const children = [
      new Paragraph({ children: [new TextRun({ text: "Timetable", bold: true, size: 28 })] }),
      new Paragraph("")
    ];

    tables.forEach(table => {
      children.push(new Paragraph({ text: `Class: ${table.className}`, spacing: { after: 200 }, underline: {} }));
      const tableRows = [];
      tableRows.push(new TableRow({
        children: table.header.map(cell => new TableCell({
          width: { size: 15, type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: [new TextRun({ text: cell, bold: true })] })],
        }))
      }));
      table.rows.forEach(row => {
        tableRows.push(new TableRow({
          children: row.map((cell, i) => new TableCell({
            width: i === 0
              ? { size: 15, type: WidthType.PERCENTAGE }
              : { size: 85 / (row.length - 1), type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: cell })] })]
          }))
        }));
      });

      children.push(new Table({ rows: tableRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      children.push(new Paragraph(""));
    });

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);

    res.setHeader('Content-Disposition', 'attachment; filename="timetable.docx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.send(buffer);

  } catch (error) {
    res.status(500).send(error.message);
  }
});


// Excel Download: Generate timetable tables in Excel.
app.get('/download/excel', async (req, res) => {
  try {
    const timetableData = loadTimetableFromFile(req.sessionID);
    const tables = buildTableData(timetableData.timetable);

    const workbook = new ExcelJS.Workbook();

    tables.forEach(table => {
      const sheet = workbook.addWorksheet(table.className);

      // Add header row
      sheet.addRow(table.header);

      // Add timetable rows
      table.rows.forEach(row => {
        sheet.addRow(row);
      });

      // Set column widths (Time column narrower, others wider)
      sheet.columns = table.header.map((_, i) => ({
        width: i === 0 ? 15 : 25
      }));

      // Format all rows (wrap text + center alignment)
      sheet.eachRow((row, rowNumber) => {
        row.eachCell(cell => {
          cell.alignment = {
            vertical: 'middle',
            horizontal: 'center',
            wrapText: true
          };
        });

        // Bold and format header row
        if (rowNumber === 1) {
          row.font = { bold: true };
          row.height = 25; // Optional: taller header row
        } else {
          row.height = 50; // Optional: consistent row height for data
        }
      });

      // Optional: Freeze top row for better UX
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
    });

    res.setHeader('Content-Disposition', 'attachment; filename="timetable.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    res.status(500).send(error.message);
  }
});


app.get('/download/json', (req, res) => {
  try {
    const timetableData = loadTimetableFromFile(req.sessionID);

    const jsonBuffer = Buffer.from(JSON.stringify(timetableData, null, 2));

    res.setHeader('Content-Disposition', 'attachment; filename="timetable.json"');
    res.setHeader('Content-Type', 'application/json');
    res.send(jsonBuffer);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// Regenerate from uploaded/edited JSON settings
function generateFromSettings(settings) {
  const {
    department, classes, faculties, startTime, endTime,
    lectureDuration, breakTimes, maxFacultyLecturesPerDay,
    maxSubjectLecturesPerDay, numberOfRooms, numberOfLabs,
    saturdayEnabled, saturdayStartTime, saturdayEndTime, saturdayBreakTimes
  } = settings;

  let days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const slotTimings = generateSlotTimings(startTime, endTime, lectureDuration, breakTimes);
  if (slotTimings.length === 0) throw new Error("No valid slots");

  const timetable = createBlankTimetables(classes, days, slotTimings);
  const facultyAvailability = initializeAvailability(faculties.map(f => f.facultyName), days, slotTimings.length);
  const rooms = Array.from({ length: numberOfRooms }, (_, i) => `Room${i + 1}`);
  const labs  = Array.from({ length: numberOfLabs }, (_, i) => `Lab${i + 1}`);
  const roomAvailability = initializeAvailability(rooms, days, slotTimings.length);
  const labAvailability  = initializeAvailability(labs, days, slotTimings.length);

  const { timetable: finalTable, subjectToLabMapping } = generateTimetable(
    timetable, facultyAvailability, roomAvailability, labAvailability,
    classes, faculties, slotTimings, days, lectureDuration,
    maxFacultyLecturesPerDay, maxSubjectLecturesPerDay
  );

  // Reuse your existing logic here to build:
  const facultyTimetable = {};
  const resourceTimetable = {};

  for (const className in finalTable) {
    for (const day in finalTable[className]) {
      finalTable[className][day].forEach(slotObj => {
        if (slotObj.lecture) {
          const timeLabel = `${slotObj.time.start} - ${slotObj.time.end}`;
          const { subject, faculty, venue } = slotObj.lecture;

          if (!facultyTimetable[faculty]) facultyTimetable[faculty] = {};
          if (!facultyTimetable[faculty][day]) facultyTimetable[faculty][day] = {};
          facultyTimetable[faculty][day][timeLabel] = `${subject} - ${className}`;

          if (!resourceTimetable[venue]) resourceTimetable[venue] = {};
          if (!resourceTimetable[venue][day]) resourceTimetable[venue][day] = {};
          resourceTimetable[venue][day][timeLabel] = `${subject} - ${className} - ${faculty}`;
        }
      });
    }
  }

  return {
    department,
    classes,
    faculties,
    startTime,
    endTime,
    lectureDuration,
    breakTimes,
    maxFacultyLecturesPerDay,
    maxSubjectLecturesPerDay,
    numberOfRooms,
    numberOfLabs,
    saturdayEnabled,
    saturdayStartTime,
    saturdayEndTime,
    saturdayBreakTimes,
    timetable: finalTable,
    facultyTimetable,
    resourceTimetable,
    breakTimes,
    saturdayBreakTimes
  };
}

app.post('/updateTimetable', (req, res) => {
  const settings = req.body;

  try {
    // ✅ Just store the manually edited timetable as-is
    req.session.generatedTimetable = settings;

    // ✅ Save to file without regenerating
    const filename = `generated_timetable_${req.sessionID}.json`;
    fs.writeFileSync(filename, JSON.stringify(settings, null, 2));

    res.json(settings);
  } catch (err) {
    console.error("Save failed:", err);
    res.status(500).send("Save failed: " + err.message);
  }
});


// Final step: server start
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
