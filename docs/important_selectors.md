it seems the "Following or Followers List" is found within the element:

document.querySelector('[role="dialog"]');

and the actual scrollable list (which only shows a limited amount of results until its scrolled to the bottom, upon which it loads more followers) is within that element.

the best way to find the actual scrollable div is, within that dialog, an element that:
- is a div
- has display: flex; flex-direction: column;
- has more than 4 children within it

this pretty accurately finds the "scrollable div" that has all the follower divs inside it.

NOTE THAT THIS DIALOG POPUP ONLY APPEARS after the "following" or "followers" number has been clicked via the user's profile (to display the popup):

these clickables to display the popup can be found via:

document.querySelector('[href="/{USERNAME}/following/"]');

or

document.querySelector('[href="/{USERNAME}/followers/"]');