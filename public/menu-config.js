/**
 * Central Navigation Configuration for The Eye
 * Defines the tabs and sub-items for each portal role.
 * Short, simple labels and clear descriptions.
 */
var MENU_CONFIG = {
  admin: [
    {
      id: 'tab-people-menu',
      label: 'People',
      icon: 'fa-users',
      dropdown: [
        {
          label: 'Teachers',
          desc: 'Manage teacher accounts.',
          href: '#tab-teachers',
          dataSection: 'tab-teachers',
          dataFeatureKey: 'teacher_management'
        },
        {
          label: 'Students',
          desc: 'Manage student accounts.',
          href: '#tab-students',
          dataSection: 'tab-students',
          dataFeatureKey: 'student_management'
        },
        {
          label: 'Coordinators',
          desc: 'Manage coordinator accounts.',
          href: '#tab-coordinators',
          dataSection: 'tab-coordinators'
        }
      ]
    },
    { id: 'tab-classes', label: 'Classes', icon: 'fa-book', href: '#tab-classes', dataSection: 'tab-classes' },
    {
      id: 'tab-attendance-menu',
      label: 'Attendance',
      icon: 'fa-clipboard-list',
      href: '#tab-attendance',
      dataSection: 'tab-attendance',
      activeSections: ['tab-attendance', 'tab-stats', 'tab-qr-attendance'],
      dropdown: [
        {
          label: 'Attendance',
          desc: 'Mark and view attendance.',
          href: '#tab-attendance',
          dataSection: 'tab-attendance'
        },
        {
          label: 'Stats',
          desc: 'See attendance numbers.',
          href: '#tab-stats',
          dataSection: 'tab-stats'
        },
        {
          label: 'QR Attendance',
          desc: 'QR-based staff attendance.',
          href: '#tab-qr-attendance',
          dataSection: 'tab-qr-attendance',
          dataFeatureKey: 'qr_attendance'
        }
      ]
    },
    {
      id: 'tab-fees-menu',
      label: 'Fees',
      icon: 'fa-money-bill-wave',
      href: '#tab-fees',
      dataSection: 'tab-fees',
      dataFeatureKey: 'fees',
      activeSections: ['tab-fees'],
      dropdown: [
        {
          label: 'Fees',
          desc: 'Fee structures, payments and reports.',
          href: '#tab-fees',
          dataSection: 'tab-fees'
        },
        {
          label: 'Collect Fee',
          desc: 'Take a fee payment and print the receipt.',
          href: '/voucher-generator.html#collect'
        },
        {
          label: 'Generate Voucher',
          desc: 'Make and print the class fee challans.',
          href: '/voucher-generator.html#generate'
        }
      ]
    },
    {
      id: 'tab-finance-menu',
      label: 'Finance',
      icon: 'fa-wallet',
      dropdown: [
        {
          label: 'Overview',
          desc: 'Review cash, income, and obligations.',
          href: '/finance-overview.html'
        },
        {
          label: 'Payroll',
          desc: 'Manage employees and payroll.',
          href: '/finance-payroll.html'
        },
        {
          label: 'Expenses',
          desc: 'Track bills, recurring costs, and estimates.',
          href: '/finance-expenses.html'
        }
      ]
    },
    {
      id: 'tab-automated',
      label: 'Automated',
      icon: 'fa-wand-magic-sparkles',
      dropdown: [
        {
          label: 'Generate Time Table',
          desc: 'Makes the weekly class timetable.',
          href: '/tt2/',
          dataFeatureKey: 'timetable'
        },
        {
          label: 'Generate Date Sheet',
          desc: 'Makes the exam dates for your classes.',
          href: '/datesheet.html'
        }
      ]
    },
    {
      id: 'tab-complaints-menu',
      label: 'Complaints',
      icon: 'fa-circle-exclamation',
      dropdown: [
        {
          label: 'Teacher complaints',
          desc: 'Complaints submitted by teachers.',
          href: '#tab-complaints',
          dataSection: 'tab-complaints',
          dataRole: 'teacher'
        },
        {
          label: 'Student complaints',
          desc: 'Complaints submitted by students.',
          href: '#tab-complaints',
          dataSection: 'tab-complaints',
          dataRole: 'student'
        },
        {
          label: 'Announcements',
          desc: 'School-wide announcements.',
          href: '#tab-announcements',
          dataSection: 'tab-announcements'
        }
      ]
    },
    { id: 'branchesTabBtn', label: 'Branches', icon: 'fa-building', href: '#tab-branches', dataSection: 'tab-branches', optional: true }
  ],

  teacher: [
    { id: 'tab-attendance-btn', label: 'Attendance', icon: 'fa-clipboard-check', href: '#tab-attendance', dataSection: 'tab-attendance' },
    { id: 'tab-homework-btn', label: 'Homework', icon: 'fa-book', href: '#tab-homework', dataSection: 'tab-homework' },
    { id: 'tab-stats-btn', label: 'Stats', icon: 'fa-chart-bar', href: '#tab-stats', dataSection: 'tab-stats' },
    {
      id: 'tab-teacher-menu',
      label: 'More',
      icon: 'fa-ellipsis',
      dropdown: [
        {
          label: 'Announcements',
          desc: 'View school announcements.',
          href: '#tab-announcements',
          dataSection: 'tab-announcements'
        },
        {
          label: 'Complaint',
          desc: 'Submit a complaint.',
          href: '/complaint.html',
          dataSection: 'tab-complaint'
        }
      ]
    }
  ],

  student: [
    { id: 'tab-teacher-btn', label: 'Teacher', icon: 'fa-chalkboard-user', href: '#tab-teacher', dataSection: 'tab-teacher' },
    { id: 'tab-attendance-btn', label: 'Attendance', icon: 'fa-clipboard-check', href: '#tab-attendance', dataSection: 'tab-attendance' },
    { id: 'tab-homework-btn', label: 'Homework', icon: 'fa-book-open', href: '#tab-homework', dataSection: 'tab-homework' },
    { id: 'tab-fees-btn', label: 'Fees', icon: 'fa-money-bill-wave', href: '#tab-fees', dataSection: 'tab-fees' },
    {
      id: 'tab-student-menu',
      label: 'More',
      icon: 'fa-ellipsis',
      dropdown: [
        {
          label: 'Announcements',
          desc: 'View school announcements.',
          href: '#tab-announcements',
          dataSection: 'tab-announcements'
        },
        {
          label: 'Complaint',
          desc: 'Submit a complaint.',
          href: '/complaint.html',
          dataSection: 'tab-complaint'
        }
      ]
    }
  ],

  coordinator: [
    { id: 'navMark', label: 'Take attendance', icon: 'fa-clipboard-check', href: '#mark', action: "switchSubTab('mark')", active: true },
    { id: 'navRecords', label: 'Saved records', icon: 'fa-clock-rotate-left', href: '#records', action: "switchSubTab('records')" },
    { id: 'navAnnouncements', label: 'Announcements', icon: 'fa-bullhorn', href: '#announcements', action: "switchSubTab('announcements')" },
    {
      id: 'navProfile',
      label: 'Profile',
      icon: 'fa-user',
      dropdown: [
        {
          label: 'Change Password',
          desc: 'Update your password.',
          action: "openPasswordModal()"
        },
        {
          label: 'Logout',
          desc: 'Sign out of your account.',
          action: "signOut()"
        }
      ]
    }
  ]
};

if (typeof window !== 'undefined') {
  window.MENU_CONFIG = MENU_CONFIG;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MENU_CONFIG;
}
