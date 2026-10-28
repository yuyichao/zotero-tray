/* eslint-env worker */
/* global ctypes */
// Waits for the file descriptors of the GLib main context in gdbus.js, so
// that the main thread does not have to block in poll().
//
// Message in: { fds: [[fd, events], ...], timeout } (milliseconds)
// Message out: [revents, ...]

var glib = ctypes.open("libglib-2.0.so.0");
var GPollFD = new ctypes.StructType("GPollFD", [
  { fd: ctypes.int },
  { events: ctypes.unsigned_short },
  { revents: ctypes.unsigned_short },
]);
var gPoll = glib.declare("g_poll", ctypes.default_abi, ctypes.int,
  GPollFD.ptr, ctypes.unsigned_int, ctypes.int);

onmessage = ({ data: { fds, timeout } }) => {
  let array = GPollFD.array(Math.max(fds.length, 1))();
  fds.forEach(([fd, events], i) => {
    array[i].fd = fd;
    array[i].events = events;
  });
  gPoll(array.addressOfElement(0), fds.length, timeout);
  postMessage(fds.map((_, i) => array[i].revents));
};
