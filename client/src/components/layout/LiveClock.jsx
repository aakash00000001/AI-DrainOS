import { useEffect, useState } from "react";

function LiveClock() {

  const [time, setTime] = useState(new Date());

  useEffect(() => {

    const timer = setInterval(() => {

      setTime(new Date());

    }, 1000);

    return () => clearInterval(timer);

  }, []);

  return (

    <div className="live-clock">

      {time.toLocaleDateString()}

      {" | "}

      {time.toLocaleTimeString()}

    </div>

  );

}

export default LiveClock;