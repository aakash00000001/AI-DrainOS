import Header from "./Header";
import Sidebar from "./Sidebar";

import "../../styles/dashboard.css";

function DashboardLayout({
  children,
  activePage,
  onNavigate,
  userRole
}) {
  return (
    <div className="dashboard-layout">

      {/* Sidebar */}
      <Sidebar
        activePage={activePage}
        onNavigate={onNavigate}
        userRole={userRole}
      />

      {/* Main Area */}
      <div className="dashboard-main">

        <Header />

        <div className="dashboard-content">

          {children}

        </div>

      </div>

    </div>
  );
}

export default DashboardLayout;