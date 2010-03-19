#ifdef DEBUG
// the following 2 lines enable logging messages to the javascript console:
var jsConsoleService = 
  Components.classes['@mozilla.org/consoleservice;1']
            .getService(Components.interfaces.nsIConsoleService);

// used for rough profiling
var gStartTime;
var gEndTime;
#endif

// see searchAndRemoveDuplicateMessagesUnthreaded()
var gEventTarget = null;
var gImapService =
  Components.classes['@mozilla.org/messenger/imapservice;1']
            .getService(Components.interfaces.nsIImapService);

var gStatusTextField;

var gOriginalsFolders;
var gOriginalsFolderUris;

var gInboxFolderFlag;
var gVirtualFolderFlag;
  
// which criteria will we use in the dupe search if the preferences
// are not set?

const SearchCriterionUsageDefaults = {
  message_id: true,
  send_time: true,
  size: true,
  folder: true,
  subject: true,
  author: true,
  num_lines: false,
  recipients: false,
  cc_list: false,
  flags: false,
  body: false
}

window.addEventListener("load", replaceGetCellProperties, false);
// this is not useful unless the event fires after all folder have
// been created - which is not the case

//---------------------------------------------------

// a class definition of the listener which we'll
// need for recursively traversing IMAP folder hierarchies,
// in which each folder needs to be asyncrhonously updated
// with its on-server contents
//---------------------------------------------------
function UpdateFolderDoneListener(folder,searchData) {
  this.folder = folder;
  this.searchData = searchData;
}

UpdateFolderDoneListener.prototype.QueryInterface =
  function(iid) {
    if (iid.equals(Components.interfaces.nsIUrlListener) ||
        iid.equals(Components.interfaces.nsISupports))
      return this;
    throw Components.results.NS_ERROR_NO_INTERFACE;
  };
  
UpdateFolderDoneListener.prototype.OnStartRunningUrl = 
  function(url) {
#ifdef DEBUG_UpdateFolderDoneListener
   jsConsoleService.logStringMessage('OnStartRunningUrl for folder ' + this.folder.abbreviatedName);
#endif
  }
  
UpdateFolderDoneListener.prototype.OnStopRunningUrl = 
  function(url, exitCode) {
#ifdef DEBUG_UpdateFolderDoneListener
   jsConsoleService.logStringMessage('OnStopRunningUrl for folder ' + this.folder.abbreviatedName);
#endif
    // TODO: Perhaps we should actually check the exist code...
    // for now we'll just assume the folder update wen't ok,
    // or we'll fail when trying to traverse the children
    traverseSearchFolderSubfolders(this.folder,this.searchData);
  };
//---------------------------------------------------


// a class for holding the search parameters (instead of
// using a bunch of globals)
//---------------------------------------------------
function DupeSearchData()
{
  this.searchSubfolders = 
    gRemoveDupesPrefs.getBoolPref("search_subfolders"); 

  this.useCriteria = new Object;
  // which information will we use for comparing messages?
  for(criterion in SearchCriterionUsageDefaults) {
    this.useCriteria[criterion] = 
     gRemoveDupesPrefs.getBoolPref("comparison_criteria." + criterion, 
                SearchCriterionUsageDefaults[criterion]);
  }

  // an optimization: if we're comparing bodies, there shouldn't be any harm
  // in comparing by number of lines first
  
  this.useCriteria['num_lines'] =
    this.useCriteria['num_lines'] || this.useCriteria['body'];

#ifdef DEBUG_DupeSearchParameters
  jsConsoleService.logStringMessage('USE criteria: '
    + (this.useCriteria['message_id'] ? 'message-ID ' : '') 
    + (this.useCriteria['send_time'] ? 'send-time ' : '') 
    + (this.useCriteria['size'] ? 'size ' : '') 
    + (this.useCriteria['folder'] ? 'folder ' : '') 
    + (this.useCriteria['subject'] ? 'subject ' : '') 
    + (this.useCriteria['author'] ? 'author ' : '') 
    + (this.useCriteria['num_lines'] ? 'line-count ' : '') 
    + (this.useCriteria['recipients'] ? 'recipients ' : '') 
    + (this.useCriteria['cc_list'] ? 'CC-list ' : '') 
    + (this.useCriteria['flags'] ? 'Flags ' : '') 
    + (this.useCriteria['body']? 'body ' : '') 
    );
  jsConsoleService.logStringMessage('DON\'T USE criteria: '
    + (!this.useCriteria['message_id'] ? 'message-ID ' : '') 
    + (!this.useCriteria['send_time'] ? 'send-time ' : '') 
    + (!this.useCriteria['size'] ? 'size ' : '') 
    + (!this.useCriteria['folder'] ? 'folder ' : '') 
    + (!this.useCriteria['subject'] ? 'subject ' : '') 
    + (!this.useCriteria['author'] ? 'author ' : '') 
    + (!this.useCriteria['num_lines'] ? 'line-count ' : '') 
    + (!this.useCriteria['recipients'] ? 'recipients ' : '') 
    + (!this.useCriteria['cc_list'] ? 'CC-list ' : '') 
    + (!this.useCriteria['flags'] ? 'Flags ' : '') 
    + (!this.useCriteria['body']? 'body ' : '') 
    );
#endif

  // when messages have no Message-ID header, Mozilla uses their MD5
  // digest value; however, the implementation is somewhat buggy and
  // two copies of the same message reportedly get different MD5s
  // sometimes; plus, it's not _really_ the message ID

  this.allowMD5IDSubstitutes = 
    gRemoveDupesPrefs.getBoolPref("allow_md5_id_substitute",false);

  // When comparing fields with address (recipients and CC list), 
  // do we compare the fields in the way and order they appear in
  // the field, or do we canonicalize the fields by taking the
  // addresses only and sorting them?

  this.compareStrippedAndSortedAddresses = 
    gRemoveDupesPrefs.getBoolPref("compare_stripped_and_sorted_addresses", false);

  this.timeComparisonResolution = 
    gRemoveDupesPrefs.getCharPref("time_comparison_resolution", "seconds");
  this.compareTimeNumerically = 
    (this.timeComparisonResolution == "seconds");


  // which of the special folders (inbox, sent, etc.) will we be willing
  // to search in for duplicates?

  this.skippingSpecialFolders = 
    gRemoveDupesPrefs.getBoolPref("skip_special_folders", true);
  
  this.useReviewDialog = 
    gRemoveDupesPrefs.getBoolPref("confirm_search_and_deletion", true);
  // we might have to trigger non-blocking IMAP folder updates;
  // each trigger will increase this, each folder update completing
  // will decrease this
  this.remainingFolders = 0;

  this.dupeSetsHashMap = new Object;
  this.folders = new Array;

  // these are used for reporting progress in the status bar
  this.messagesHashed = 0;
  this.setsRefined = 0;
  this.totalOriginalDupeSets = 0;

  // maximum number of messages to process
  this.limitNumberOfMessages = 
    gRemoveDupesPrefs.getBoolPref("limit_number_of_processed_messages", false);
#ifdef DEBUG_DupeSearchParameters
     jsConsoleService.logStringMessage(
      'this.limitNumberOfMessages ' + this.limitNumberOfMessages);
#endif
  this.maxMessages = 
    gRemoveDupesPrefs.getIntPref("processed_messages_limit", 10000);
#ifdef DEBUG_DupeSearchParameters
     jsConsoleService.logStringMessage(
      'this.maxMessages ' + this.maxMessages);
#endif
  
  // timing is used to decide when to make the next status
  // bar progress report and for yielding for processing UI events
  // (values here are in miliseconds)
  this.lastStatusBarReport = this.lastYield = (new Date()).getTime();
  this.yieldQuantum =
    gRemoveDupesPrefs.getIntPref("yield_quantum", 200);
  this.reportQuantum =
    gRemoveDupesPrefs.getIntPref("status_report_quantum", 1500);

  if (gOriginalsFolders) {
    this.originalsFolderUris = gOriginalsFolderUris;
    this.originalsFolders = gOriginalsFolders;
  }
}
//---------------------------------------------------


// searchAndRemoveDuplicateMessages - 
// Called from the UI to trigger a new dupe search

function searchAndRemoveDuplicateMessages()
{
#ifdef DEBUG_searchAndRemoveDuplicateMessages
  jsConsoleService.logStringMessage('searchAndRemoveDuplicateMessages()');
#endif

  // for some reason this is no longer defined recent Seamonkey trunk versions
  try {
    gInboxFolderFlag   = Components.interfaces.nsMsgFolderFlags.Inbox;
    gVirtualFolderFlag = Components.interfaces.nsMsgFolderFlags.Virtual;
  } catch(ex) {
    gInboxFolderFlag   = 0x1000; // MSG_FOLDER_FLAG_INBOX
    gVirtualFolderFlag = 0x0020; // MSG_FOLDER_FLAG_VIRTUAL
  }
    
  //document.getElementById('progress-panel').removeAttribute('collapsed'); 
  gStatusTextField = document.getElementById('statusText');
  gStatusTextField.label =
    gRemoveDupesStrings.GetStringFromName('removedupes.searching_for_dupes');

  // we'll need this for some calls involving UrlListeners
  
  if (gEventTarget == null) {
    if ("nsIThreadManager" in Components.interfaces) {
       gEventTarget = 
         Components.classes['@mozilla.org/thread-manager;1']
                   .getService().currentThread;
    } else {
       var eventQueueService =
         Components.classes['@mozilla.org/event-queue-service;1']
                   .getService(Components.interfaces.nsIEventQueueService);
       gEventTarget = 
         eventQueueService.getSpecialEventQueue(
           eventQueueService.CURRENT_THREAD_EVENT_QUEUE);
    }
  }
  
  var searchData = new DupeSearchData();
  // the marked 'originals folders' are only used as such
  // for this coming search, not for subsequent searches
  gOriginalsFolders = null;
  gOriginalsFolderUris = null;
  if (typeof gFolderTreeView != 'undefined')
    gFolderTreeView._tree.invalidate();
  searchData.keyPressEventListener =
    function(ev) {onKeyPress(ev,searchData);}
  window.addEventListener("keypress", searchData.keyPressEventListener, true);
  beginSearchForDuplicateMessages(searchData);
}

function onKeyPress(ev,searchData)
{
  if ((ev.keyCode == KeyEvent.DOM_VK_CANCEL ||
       ev.keyCode == 27 ||
       ev.keyCode == KeyEvent.DOM_VK_BACK_SPACE) &&
      !ev.shiftKey && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
#ifdef DEBUG_onKeyPress
    jsConsoleService.logStringMessage("Esc Esc");
#endif
    searchData.userAborted = true;
  }
#ifdef DEBUG_onKeyPress
  jsConsoleService.logStringMessage("got other keycode: " + ev.keyCode + " | " + String.fromCharCode(ev.keyCode));
#endif
}

function beginSearchForDuplicateMessages(searchData)
{
  searchData.topFolders = GetSelectedMsgFolders();

  // TODO: check we haven't selected some folders along with
  // their subfolders - this would mean false dupes!
  
  for(var i = 0; i < searchData.topFolders.length; i++) {
    var folder = searchData.topFolders[i];
    if (searchData.skippingSpecialFolders) {
      if (!folder.canRename && (folder.rootFolder != folder) ) {
#ifdef DEBUG_beginSearchForDuplicateMessages
        jsConsoleService.logStringMessage('special folder ' + folder.abbreviatedName);
#endif
        // one of the top folders is a special folders; if it's not
        // the Inbox (which we do search), skip it
        if (!(folder.flags & gInboxFolderFlag)) {
#ifdef DEBUG_beginSearchForDuplicateMessages
          jsConsoleService.logStringMessage('skipping special folder ' + folder.abbreviatedName + 'due to ' + folder.flags + ' & ' + gInboxFolderFlag + ' = ' + (folder.flags & gInboxFolderFlag));
#endif
          continue;
        }
      }
    }
#ifdef DEBUG_beginSearchForDuplicateMessages
    jsConsoleService.logStringMessage('addSearchFolders for ' + folder.abbreviatedName);
#endif
    addSearchFolders(folder,searchData);
  }

  if (searchData.folders.length == 0) {
    // all the possible folders were skipped for some reason or
    // another; abort the search
    window.removeEventListener("keypress", searchData.keyPressEventListener, true);
    delete searchData;
    gStatusTextField.label =
      gRemoveDupesStrings.GetStringFromName('removedupes.search_aborted');
    return;
  }

  delete searchData.topFolders;
#ifdef DEBUG_collectMessages
   jsConsoleService.logStringMessage('done with addSearchFolders() calls\nsearchData.remainingFolders = ' + searchData.remainingFolders);
#endif

  // At this point, one would expected searchData.folders to contain
  // all of the folders and subfolders we're collecting messages from -
  // but, alas this cannot be... We have to wait for all the IMAP
  // folders and subfolders to become ready and then be processed;
  // so let's call a sleep-poll function
  
  waitForFolderCollection(searchData);
}

// addSearchFolders - 
// supposed to recursively traverse the subfolders of a
// given folder, marking them for inclusion in the dupe search;
// however, it can't really do this in the straightforward way, as for
// IMAP folders one needs to make sure they're ready before acting, so
// instead, it only marks the current folder and has traverseSearchFolderSubfolders
// called either synchronously or asynchronously to complete its work

function addSearchFolders(folder, searchData)
{
#ifdef DEBUG_addSearchFolders
  jsConsoleService.logStringMessage('addSearchFolders for folder ' + folder.abbreviatedName +
   '\nrootFolder = ' + folder.rootFolder + ((folder.rootFolder == folder) ? ' - self!' : ' - not self!') +
   '\ncanFileMessages = ' + folder.canFileMessages +
   '\nfolder.canRename = ' + folder.canRename
  );
#endif

  if (!folder.canRename && (folder.rootFolder != folder) ) {
    // it's a special folder
    if (searchData.skippingSpecialFolders) {
      if (!(folder.flags & gInboxFolderFlag)) {
        return;
      }
#ifdef DEBUG_addSearchFolders
      jsConsoleService.logStringMessage('special folder ' + folder.abbreviatedName + ' is allowed');
#endif
    }
  }
  if (folder.flags & gVirtualFolderFlag) {
    // it's a virtual search folder, skip it
#ifdef DEBUG_addSearchFolders
    jsConsoleService.logStringMessage('skipping virtual search folder ' + folder.abbreviatedName);
#endif
    return;
  }
    

  searchData.remainingFolders++;

  // Skipping folders which are not special, but by definition cannot
  // have duplicates

  // TODO: There may theoretically be other URI prefixes which we need to avoid
  // in addition to 'news://'

  if (folder.URI.substring(0,7) != 'news://') {
    if (searchData.originalsFolderUris) {
      if (!searchData.originalsFolderUris[folder.URI]) {
#ifdef DEBUG_addSearchFolders
        jsConsoleService.logStringMessage('pushing non-originals folder ' + folder.abbreviatedName);
#endif
        searchData.folders.push(folder);
      }
#ifdef DEBUG_addSearchFolders
      else jsConsoleService.logStringMessage('not pushing folder ' + folder.abbreviatedName + ' - it\'s an originals folder');
#endif
    }
    else {
#ifdef DEBUG_addSearchFolders
      jsConsoleService.logStringMessage('pushing folder ' + folder.abbreviatedName);
#endif
      searchData.folders.push(folder);
    }
  }
#ifdef DEBUG_addSearchFolders
  else jsConsoleService.logStringMessage('not pushing folder ' + folder.abbreviatedName + ' - since it has no root folder or can\'t file messages');
#endif

  // is this an IMAP folder?
  
  try {
    var imapFolder = folder.QueryInterface(Components.interfaces.nsIMsgImapMailFolder);
    var listener = new UpdateFolderDoneListener(folder,searchData);
    var dummyUrl = new Object;
    gImapService.selectFolder(gEventTarget, folder, listener, msgWindow, dummyUrl);
    // no traversal of children - the listener will take care of that in due time
#ifdef DEBUG_addSearchFolders
    jsConsoleService.logStringMessage('returning from addSearchFolders for folder ' + folder.abbreviatedName + ':\ntriggered IMAP folder update');
#endif
    return;

  } catch (ex) {}
  
  // Is this a locally-stored folder with its DB out-of-date?
  
  try {
    var localFolder = folder.QueryInterface(Components.interfaces.nsIMsgLocalMailFolder);
    try {
      var db = localFolder.getDatabaseWOReparse();
    } catch (ex) {
      var listener = new UpdateFolderDoneListener(folder,searchData);
      folder.parseFolder(msgWindow, listener);
      // no traversal of children - the listener will take care of that in due time
#ifdef DEBUG_addSearchFolders
      jsConsoleService.logStringMessage('returning from addSearchFolders for folder ' + folder.abbreviatedName + ':\ntriggered local folder db update');
#endif
      return;
    }
  } catch (ex) {
  }
 
  // We assume at this point the folder is locally-stored and its message db is up-to-date,
  // so we can traverse its subfolders without any more preparation
  
  traverseSearchFolderSubfolders(folder,searchData);
  
#ifdef DEBUG_addSearchFolders
  jsConsoleService.logStringMessage('returning from addSearchFolders for folder ' + folder.abbreviatedName + ':\nperformed traversal');
#endif
}

// traverseSearchFolderSubfolders - 
// Completes the work of addSearchFolder by traversing a
// folder's children once it's 'ready'; it is called asynchronously
// for IMAP folders

function traverseSearchFolderSubfolders(folder,searchData)
{
#ifdef DEBUG_traverseSearchFolderSubfolders
  jsConsoleService.logStringMessage('in traverseSearchFolderSubfolders for folder ' + folder.abbreviatedName);
#endif

  gStatusTextField.label = gRemoveDupesStrings.GetStringFromName('removedupes.searching_for_dupes');

  // traverse the children

  if (searchData.searchSubfolders && folder.hasSubFolders) {
    // the GetSubFolders() function was removed in bugzilla.mozilla.org bug 420614;
    // so we have here both its use for older builds and the workaround created
    // by the patch for that bug
    var subFoldersIterator = null;
    try {
      subFoldersIterator = folder.GetSubFolders();
    }
    catch(ex) {
      subFoldersIterator = folder.subFoldersObsolete;
    }
    if (subFoldersIterator) {
      do {
        addSearchFolders(
          subFoldersIterator.currentItem().QueryInterface(
            Components.interfaces.nsIMsgFolder),
          searchData);
        try {
         subFoldersIterator.next();
        } catch (ex) {
          break;
        }
      } while(true);
    }
    else {
      var subFoldersEnumerator = folder.subFolders;
      while (subFoldersEnumerator.hasMoreElements()) {
        addSearchFolders(
          subFoldersEnumerator.getNext().QueryInterface(
            Components.interfaces.nsIMsgFolder),
          searchData);
      }
    }
  }

  searchData.remainingFolders--;

#ifdef DEBUG_traverseSearchFolderSubfolders
  jsConsoleService.logStringMessage('returning from traverseSearchFolderSubfolders for folder ' + folder.abbreviatedName);
#endif
}

// the folder collection for a dupe search happens asynchronously; this function
// waits for the folder collection to conclude (sleeping and calling itself
// again if it hasn't), before continuing to the collection of messages
// from the folders

function waitForFolderCollection(searchData)
{
#ifdef DEBUG_waitForFolderCollection
   jsConsoleService.logStringMessage('in waitForFolderCollection\nsearchData.remainingFolders = ' + searchData.remainingFolders);
#endif

  gStatusTextField.label = gRemoveDupesStrings.GetStringFromName('removedupes.searching_for_dupes');

  if (searchData.userAborted) {
    window.removeEventListener("keypress", searchData.keyPressEventListener, true);
    delete searchData;
    gStatusTextField.label =
      gRemoveDupesStrings.GetStringFromName('removedupes.search_aborted');
    return;
  }

  // ... but it might still be the case that we haven't finished 
  // traversingfolders and collecting their subfolders for the dupe
  // search, so we may have to wait some more

  if (searchData.remainingFolders > 0) {
    setTimeout(waitForFolderCollection,100,searchData);
    return;
  }
  processMessagesInCollectedFoldersPhase1(searchData);
}

// processMessagesInCollectedFoldersPhase1 - 
// Called after we've collected all of the folders
// we need to process messages in. The processing of messages has
// two phases - first, all messages are hashed into a possible-dupe-sets
// hash, then the sets of messages with the same hash values are
// refined using more costly comparisons than the hashing itself.
// The processing can take a long time; to allow the UI to remain 
// responsive and the user to be able to abort the dupe search, we
// perform the first phase using a generator and a separate function 
// which occasionally yields

function processMessagesInCollectedFoldersPhase1(searchData)
{
  // At this point all UrlListeners have finished their work, and all
  // relevant folders have been added to the searchData.folders array

  if (searchData.userAborted) {
    window.removeEventListener("keypress", searchData.keyPressEventListener, true);
    delete searchData;
    gStatusTextField.label =
      gRemoveDupesStrings.GetStringFromName('removedupes.search_aborted');
    return;
  }

#ifdef DEBUG_collectMessages
   jsConsoleService.logStringMessage('in continueSearchForDuplicateMessages');
#endif
  searchData.generator = populateDupeSetsHash(searchData);
  setTimeout(processMessagesInCollectedFoldersPhase2, 10, searchData);
}

// processMessagesInCollectedFoldersPhase2 - 
// A wrapper for the  'Phase2' function waits for the first phase to complete, 
// calling itself with a timeout otherwise; after performing the second phase,
// it calls the post-search reviewAndRemoveDupes function (as we're working
// asynchronously)

function processMessagesInCollectedFoldersPhase2(searchData)
{
  if (searchData.userAborted) {
    window.removeEventListener("keypress", searchData.keyPressEventListener, true);
    delete searchData;
    gStatusTextField.label =
      gRemoveDupesStrings.GetStringFromName('removedupes.search_aborted');
    return;
  }
  // what happens if generator is null?
  if (searchData.generator) {
    try {
      searchData.generator.next();
      setTimeout(processMessagesInCollectedFoldersPhase2, 100, searchData);
      return;
    }
    catch (ex if ex instanceof StopIteration) { 
      // if we've gotten here, it means the populateDupeSetsHash function,
      // associated with the generator, has finally completed its execution
#ifdef DEBUG_processMessagesInCollectedFoldersPhase2
  jsConsoleService.logStringMessage('populateDupeSetsHash execution complete');
#endif
      delete searchData.generator;
    }
  }
  delete searchData.folders;

  // some criteria are not used when messages are first collected, so the
  // hash map of dupe sets might be a 'rough' partition into dupe sets, which
  // still needs to be refined by additional comparison criteria
  
  refineDupeSets(searchData);

  if (searchData.userAborted) {
    window.removeEventListener("keypress", searchData.keyPressEventListener, true);
    delete searchData;
    gStatusTextField.label =
      gRemoveDupesStrings.GetStringFromName('removedupes.search_aborted');
    return;
  }
  
  if (isEmpty(searchData.dupeSetsHashMap)) {
    if (searchData.useReviewDialog) {
      // if the user wants a dialog to pop up for the dupes, we can bother him/her
      // with a message box for 'no dupes'
      gStatusTextField.label = '';
      alert(gRemoveDupesStrings.GetStringFromName("removedupes.no_duplicates_found"));
    }
    else {
      // if the user wanted silent removal, we'll be more quiet about telling
      // him/her there are no dupes
      gStatusTextField.label = 
        gRemoveDupesStrings.GetStringFromName("removedupes.no_duplicates_found");
    }
    delete(searchData);
  }
  else {
    gStatusTextField.label =
      gRemoveDupesStrings.GetStringFromName("removedupes.search_complete");
    reviewAndRemoveDupes(searchData);
    //document.getElementById('progress-panel').setAttribute('collapsed', true); 
  }
}

// stripAndSortAddreses - 
// Takes a MIME header field (hopefully, decoded for appropriate charset
// and transfer encoding), strips out the email addresses in it, and
// returns them, sorted, in a string

const gEmailRegExp = RegExp(
  "[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@" +
  "(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?","g");
const gEcnodedWordRegExp = RegExp("=\?.*\?=","g");
  
function stripAndSortAddresses(headerString)
{
#ifdef DEBUG_stripAndSortAddresses
  jsConsoleService.logStringMessage('stripAndSortAddresses(' + headerString +  ')');
#endif
  // if we suspect there's undecoded text, let's not do anything and
  // keep the field the way it is; at worst, we'll have some false-non-dupes
  if ((headerString == null) || (headerString == ""))
    return headerString;
  if (gEcnodedWordRegExp.test(headerString))
    return headerString;
  var matches;
  try {
    matches = headerString.match(gEmailRegExp).sort();
  } catch(ex) {}
  return matches;
}

// sillyHash - 
// Calculates the hash used for the first-phase separation of non-dupe
// messages; it relies on the non-expensive comparison criteria

function sillyHash(searchData,messageHdr,folder)
{
  // Notes:
  // 1. There could theoretically be two messages which should not
  //    have the same hash, but do have it, if the subject includes the
  //    string |6xX$\WG-C?| or the author includes the string 
  //    '|^#=)A?mUi5|' ; this is however highly unlikely... about as 
  //    unlikely as collisions of a hash function, except that we haven't
  //    randomized; still, if a malicious user sent you e-mail with these
  //    strings in the author or subject fields, you probably don't care
  //    about deleting them anyways
  // 2. We're not making full body comparisons/hashing here - only after
  //    creating dupe sets based on the 'cheap' criteria will we look at
  //    the message body

  var retVal = '';
  if (searchData.useCriteria['message_id']) {
    var messageId =
      ((searchData.allowMD5IDSubstitutes || messageHdr.messageId.substr(0,4) != 'md5:') ?
      messageHdr.messageId : '');
    // some mail servers add newlines and spaces before or after message IDs
    retVal += messageId.replace(/(\n|^)\s+|\s+$/,"") + '|';
  }
  if (searchData.useCriteria['send_time']) {
    if (searchData.compareTimeNumerically)
      retVal += messageHdr.dateInSeconds + '|';
    else {
      var date = new Date( messageHdr.dateInSeconds*1000 );
      switch(searchData.timeComparisonResolution) {
        case "seconds":
          retVal += date.getSeconds() + '|';
        case "minutes":
          retVal += date.getMinutes() + '|';
        case "hours":
          retVal += date.getHours() + '|';
        case "day":
          retVal += date.getDate() + '|';
        case "month":
          retVal += date.getMonth() + '|';
        case "year":
          retVal += date.getFullYear() + '|';
          break;
        default:
          // if someone uses an invalid comparison resolution,
          // they'll get a maximum-resolution comparison
          // to avoid false positives
          retVal += messageHdr.dateInSeconds + '|';
      }
    }
  }
  if (searchData.useCriteria['size'])
    retVal += messageHdr.messageSize + '|';
  if (searchData.useCriteria['folder'])
    retVal += folder.URI + '|';
  if (searchData.useCriteria['subject'])
    retVal += messageHdr.subject + '|6xX$\WG-C?|';
      // the extra 'junk string' is intended to reduce the chance of getting the subject
      // field being mixed up with other fields in the hash, i.e. in case the subject
      // ends with something like "|55"
  if (searchData.useCriteria['author'])
    retVal += 
      (searchData.compareStrippedAndSortedAddresses ?
      stripAndSortAddresses(messageHdr.mime2DecodedAuthor) : messageHdr.author)
      + '|^#=)A?mUi5|';
  if (searchData.useCriteria['recipients'])
    retVal += 
      (searchData.compareStrippedAndSortedAddresses ?
      stripAndSortAddresses(messageHdr.mime2DecodedRecipients) : messageHdr.recipients)
      + '|Ei4iXn=Iv*|';
  // note: 
  // We're stripping here the non-MIME-transfer-encoding-decoded CC list!
  // It might not work but we don't have immediate access to the decoded
  // version...
  if (searchData.useCriteria['cc_list'])
    retVal += 
      (searchData.compareStrippedAndSortedAddresses ?
      stripAndSortAddresses(messageHdr.ccList) : messageHdr.ccList)
      + '|w7Exh\' s%k|';
  if (searchData.useCriteria['num_lines'])
    retVal += messageHdr.lineCount + '|';
  if (searchData.useCriteria['flags'])
    retVal += messageHdr.flags;
  return retVal;
}

// The actual first phase of message processing (see
// processMessagesInCollectedFoldersPhase1 for more details)

function populateDupeSetsHash(searchData)
{
#ifdef DEBUG_populateDupeSetsHash
   jsConsoleService.logStringMessage('in populateDupeSetsHash()');
#endif

  // messageUriHashmap  will be filled with URIs for _all_ messages;
  // the dupe set hashmap will only have entries for dupes, and these
  // entries will be sets of dupes (technically, arrays of dupes)
  // rather than URIs
  var messageUriHashmap = new Object;

#ifdef DEBUG_populateDupeSetsHash
   if (searchData.originalsFolders) {
     jsConsoleService.logStringMessage('number of search folders: ' +
       searchData.originalsFolders.length + ' originals + ' + searchData.folders.length + ' others' );
   }
   else  jsConsoleService.logStringMessage('number of search folders: ' + searchData.folders.length);
#endif

  // this next bit of code is super-ugly, because I need the yield'ing to happen from 
  // this function - can't yield from a function you're calling; isn't life great?
  // isn't lack of threading fun?
  var i = 0;
  var endI = 0;
  if (searchData.originalsFolders)
    endI = searchData.originalsFolders.length;
  var allowNewUris = true;
  var doneWithOriginals = false;
  var folders = searchData.originalsFolders;
  while (   (i < endI || !doneWithOriginals)
         && (   !searchData.limitNumberOfMessages 
             || (searchData.messagesHashed < searchData.maxMessages))  ) {
    if (i == endI) {
      doneWithOriginals = true;
      folders = searchData.folders;
      if (folders.length == 0)
        break;
      endI = folders.length;
      allowNewUris = (searchData.originalsFolders ? false : true);
      i = 0;
    }
    var folder = folders[i];
#ifdef DEBUG_populateDupeSetsHash
    jsConsoleService.logStringMessage(
        'populateDupeSetsHash for folder ' + folder.abbreviatedName + '\n' +
        (allowNewUris ? '' : 'not') + 'allowing new URIs');
#endif
    if (folder.isServer == true) {
      // shouldn't get here
      i++;
      continue;
    }

    var folderMessageHdrsIterator;
    try {
#ifdef DEBUG_populateDupeSetsHash
      jsConsoleService.logStringMessage('trying getMessages(msgWindows) for folder ' + folder.abbreviatedName);
#endif
      folderMessageHdrsIterator =
        folder.getMessages(msgWindow);
    } catch(ex) {
      try {
#ifdef DEBUG_populateDupeSetsHash
        jsConsoleService.logStringMessage('trying getMessages() for folder ' + folder.abbreviatedName);
#endif
        folderMessageHdrsIterator = folder.messages;
      } catch(ex) {
#ifdef DEBUG
          jsConsoleService.logStringMessage('accessing messages failed for folder ' + folder.abbreviatedName + ' :\n' + ex);
#else
          dump(gRemoveDupesStrings.formatStringFromName('removedupes.failed_getting_messages', [folder.abbreviatedName], 1) + '\n');
#endif
      }
    }

    while (   folderMessageHdrsIterator.hasMoreElements() 
           && (!searchData.limitNumberOfMessages 
               || (searchData.messagesHashed < searchData.maxMessages)) ) {
      var messageHdr = 
        folderMessageHdrsIterator.getNext()
               .QueryInterface(Components.interfaces.nsIMsgDBHdr);

      var messageHash = sillyHash(searchData,messageHdr,folder);
      var uri = folder.getUriForMsg(messageHdr);

      if (messageHash in messageUriHashmap) {
        if (messageHash in searchData.dupeSetsHashMap) {
#ifdef DEBUG_populateDupeSetsHash
          jsConsoleService.logStringMessage('sillyHash\n' + messageHash + '\nis a third-or-later dupe');
#endif
          // just add the current message's URI, no need to copy anything
          searchData.dupeSetsHashMap[messageHash].push(uri);
        } 
        else {
#ifdef DEBUG_populateDupeSetsHash
          jsConsoleService.logStringMessage('sillyHash\n' + messageHash + '\nis a second dupe');
#endif
          // the URI in messageUriHashmap[messageHash] has not been copied to
          // the dupes hash since until now we did not know it was a dupe;
          // copy it together with our current message's URI
          // TODO: use [blah, blah] as the array constructor
          searchData.dupeSetsHashMap[messageHash] = 
            new Array(messageUriHashmap[messageHash], uri);
          searchData.totalOriginalDupeSets++;
        }
      } 
      else {
#ifdef DEBUG_populateDupeSetsHash
        jsConsoleService.logStringMessage('sillyHash\n' + messageHash + '\nis not a dupe (or a first dupe)');
#endif
        if (allowNewUris) {
          messageUriHashmap[messageHash] = uri;
        }
      }

      searchData.messagesHashed++;
      var currentTime = (new Date()).getTime();    
      if (currentTime - searchData.lastStatusBarReport > searchData.reportQuantum) {
        searchData.lastStatusBarReport = currentTime;
        gStatusTextField.label =
          gRemoveDupesStrings.formatStringFromName(
          'removedupes.hashed_x_messages', [searchData.messagesHashed], 1);
      }
      if (currentTime - searchData.lastYield > searchData.yieldQuantum) {
        searchData.lastYield = currentTime;
        yield;
      }
    }
    i++;
  }
}

// messageBodyFromURI -
// An 'expensive' function used in the second phase of messgage
// processing, in which suspected sets of dupes are refined

function messageBodyFromURI(msgURI)
{
  var msgContent = "";
#ifdef DEBUG_messageBodyFromURI
   jsConsoleService.logStringMessage('in messageBodyFromURI(' + msgURI + ')');
#endif
  var MsgService;
  try {
    MsgService = messenger.messageServiceFromURI(msgURI);
  } catch (ex) {
    alert('Error getting message service for message ' + msgURI + '\n: ' + ex);
    return null;
  }
  var MsgStream =  Components.classes["@mozilla.org/network/sync-stream-listener;1"].createInstance();
  var consumer = MsgStream.QueryInterface(Components.interfaces.nsIInputStream);
  var ScriptInput = Components.classes["@mozilla.org/scriptableinputstream;1"].createInstance();
  var ScriptInputStream = ScriptInput.QueryInterface(Components.interfaces.nsIScriptableInputStream);
  ScriptInputStream.init(consumer);
  try {
    MsgService .streamMessage(msgURI, MsgStream, msgWindow, null, false, null);
  } catch (ex) {
    alert('Error getting message content:\n' + ex)
    return null;
  }
  ScriptInputStream.available();
  while (ScriptInputStream.available()) {
    msgContent = msgContent + ScriptInputStream.read(512);
  }
  
  // the message headers end on the first empty line, and lines are delimited
  // by \n's or \r\n's ; of course, this is a very lame hack, since if the 
  // message has multiple MIME parts we're still getting the headers of all 
  // the sub-parts, and not taking into any account the multipart delimiters
  var endOfHeaders = /\r?\n\r?\n/;
  if (endOfHeaders.test(msgContent)) {
#ifdef DEBUG_messageBodyFromURI
  //jsConsoleService.logStringMessage('msgContent =\n\n' + msgContent);
  //jsConsoleService.logStringMessage('msgContent =\n\n' + string2hexWithNewLines(msgContent));
  jsConsoleService.logStringMessage('RegExp.rightContext =\n\n' + RegExp.rightContext);
#endif
    // return everything after the end-of-headers
    return RegExp.rightContext;
  }
#ifdef DEBUG_messageBodyFromURI
  jsConsoleService.logStringMessage('Can\'t match /\\r?\\n\\r?\\n/');
#endif
  return null;
}

// Write some progress info to the status bar

function reportRefinementProgress(searchData,activity,setSize,curr)
{
  var currentTime = (new Date()).getTime();
  if (currentTime - searchData.lastStatusBarReport > searchData.reportQuantum) {
    searchData.lastStatusBarReport = (new Date()).getTime();
    switch (activity) {
      case 'bodies':
        gStatusTextField.label =
          gRemoveDupesStrings.formatStringFromName(
            'removedupes.refinement_status_getting_bodies',
            [searchData.setsRefined,
             searchData.totalOriginalDupeSets,
             curr,
             setSize
            ], 4);
        break;
      case 'subsets':
        gStatusTextField.label =
          gRemoveDupesStrings.formatStringFromName(
            'removedupes.refinement_status_building_subsets',
            [searchData.setsRefined,
             searchData.totalOriginalDupeSets,
             setSize-curr,
             setSize             
            ], 4);
        break;
    }
  }
}

// The actual second phase of message processing (see
// processMessagesInCollectedFoldersPhase2 for more details)

function refineDupeSets(searchData)
{
  if (!searchData.useCriteria['body'])
    return;

  // we'll split every dupe set into separate sets based on additional
  // comparison criteria (the more 'expensive' ones); size-1 dupe sets
  // are removed from the hash map entirely.
  
  // TODO: for now, our only 'expensive' criterion is the message body,
  // so I'm leaving the actual comparison code in this function and
  // not even checking for searchData.useBody; if and when we get additional
  // criteria this should be rewritten so that dupeSet[i] gets
  // a comparison record created for it, then for every j we call
  // ourcomparefunc(comparisonrecord, dupeSet[j])
  
  for (hashValue in searchData.dupeSetsHashMap) {
    var dupeSet = searchData.dupeSetsHashMap[hashValue];
#ifdef DEBUG_refineDupeSets
    jsConsoleService.logStringMessage('refining for dupeSetsHashMap value ' + hashValue + '\nset has ' + dupeSet.length + ' elements initially');
#endif
    
    // get the message bodies
    
    var initialSetSize = dupeSet.length;
    
    for (var i=0; i < dupeSet.length; i++) {
      var dupeUri = dupeSet[i];
      dupeSet[i] = {
        uri: dupeUri, 
        body: messageBodyFromURI(dupeUri)
      }
      if (searchData.userAborted)
        return;
      reportRefinementProgress(searchData, 'bodies', initialSetSize, i);
    }

#ifdef DEBUG_refineDupeSets
    jsConsoleService.logStringMessage('got the bodies');
#endif
    
    // sort the bodies
    
    dupeSet.sort(
      function(lhs,rhs) {
        return lhs - rhs;
      } );

#ifdef DEBUG_refineDupeSets
    jsConsoleService.logStringMessage('done sorting');
#endif

    if (searchData.userAborted)
      return;
    
    // now build sub-dupesets from identical-body sequences of the sorted array
    
    var subsetIndex = 0;
    while(dupeSet.length > 0) {
      if (searchData.userAborted)
        return;
      if (!dupeSet[0].body) {
        dupeSet.shift();
      }
      var subsetLength = 1;
      while( (subsetLength < dupeSet.length) &&
             (dupeSet[subsetLength].body == dupeSet[0].body) ) {
        subsetLength++;
        dupeSet[subsetLength-1] = dupeSet[subsetLength-1].uri;
      }
      if (subsetLength > 1) {
        dupeSet[0] = dupeSet[0].uri;
        searchData.dupeSetsHashMap[hashValue + '|' + (i++)] = dupeSet.splice(0,subsetLength);
      }
      else dupeSet.shift();
      reportRefinementProgress(searchData, 'subsets', initialSetSize, dupeSet.length);

    }
    delete searchData.dupeSetsHashMap[hashValue];
    searchData.setsRefined++;
  }
}

// reviewAndRemoveDupes - 
// This function either moves the dupes, erases them completely,
// or fires the review dialog for the user to decide what to do

function reviewAndRemoveDupes(searchData)
{
#ifdef DEBUG_reviewAndRemove
  jsConsoleService.logStringMessage('in reviewAndRemoveDupes');
#endif

  window.removeEventListener("keypress", searchData.keyPressEventListener, true);
  if (searchData.userAborted) {
    delete searchData;
    gStatusTextField.label =
      gRemoveDupesStrings.GetStringFromName('removedupes.search_aborted');
    return;
  }

  if (!searchData.useReviewDialog)
  {
    // remove (move to trash or erase completely)
    // without user confirmation or review; we're keeping the first dupe
    // in every sequence of dupes and deleting the rest
    removeDuplicates(
      searchData.dupeSetsHashMap,
      (gRemoveDupesPrefs.getCharPref('default_action', 'move') == 'delete_permanently'),
      gRemoveDupesPrefs.getCharPref('default_target_folder', null),
      false // the uri's have not been replaced with messageRecords
      );
  }
  else {
    if (!gMessengerBundle)
      gMessengerBundle = document.getElementById("bundle_messenger");
    var dialogURI = "chrome://removedupes/content/removedupes-dialog.xul";
#ifdef MOZ_THUNDERBIRD
    if (rdGetAppVersion() < "3") {
#ifdef DEBUG_reviewAndRemove
      jsConsoleService.logStringMessage('App Version >= 3');
#endif
      dialogURI = "chrome://removedupes/content/removedupes-dialog.tb2.xul"
    }
#ifdef DEBUG_reviewAndRemove
    else {
      jsConsoleService.logStringMessage('App Version < 3');
    }    
#endif
#endif

    // open up a dialog in which the user sees all dupes we've found,
    // and can decide which to delete
    window.openDialog(
      dialogURI,
      "removedupes",
      "chrome,resizable=yes",
      messenger,
      msgWindow,
      gMessengerBundle,
      gDBView,
      searchData.useCriteria,
      searchData.dupeSetsHashMap,
      searchData.originalsFolderUris,
      searchData.allowMD5IDSubstitutes);
  }
  delete searchData;
}

function toggleDupeSearchCriterion(ev,criterion)
{
  var useCriterion = 
    !gRemoveDupesPrefs.getBoolPref("comparison_criteria." + criterion, 
      SearchCriterionUsageDefaults[criterion]);
  gRemoveDupesPrefs.setBoolPref("comparison_criteria." + criterion, useCriterion);
  document.getElementById('removedupesCriterionMenuItem_' + criterion).setAttribute("checked", useCriterion ? "true" : "false");
  ev.stopPropagation();
}

function removedupesCriteriaPopupMenuInit()
{
  for(criterion in SearchCriterionUsageDefaults) {
    document.getElementById('removedupesCriterionMenuItem_' + criterion)
            .setAttribute("checked",
              (gRemoveDupesPrefs.getBoolPref("comparison_criteria." + criterion, 
                SearchCriterionUsageDefaults[criterion]) ? "true" : "false"));
  }
}

// This function is only used if the gFolderTreeView object is available
// (for now, in TBird 3.x and later but not in Seamonkey 2.1.x and earlier);
// it replaces the callback for getting folder tree cell properties with
// a function which also adds the property of being a removedupes originals
// folder or not.
// In the hope that the gFolderTreeView will appear in Seamonkey as well, 
// I'm not ifdef-ing this function and other relevant code to TBird-only

function replaceGetCellProperties()
{
  if (typeof gFolderTreeView == 'undefined')
    return;
    
  var atomService =
    Components.classes["@mozilla.org/atom-service;1"]
              .getService(Components.interfaces.nsIAtomService);

  gFolderTreeView.getCellProperties = function gcp(aRow, aCol, aProps) {
    var row = gFolderTreeView._rowMap[aRow];
    row.getProperties(aProps, aCol);
    if (gOriginalsFolderUris && gOriginalsFolderUris[row._folder.URI]) {
      aProps.AppendElement(atomService.getAtom("isOriginalsFolder-true"));
    }
    else {
      aProps.AppendElement(atomService.getAtom("isOriginalsFolder-false"));
    }
  };
}

function setOriginalsFolders()
{
  if (typeof gFolderTreeView == 'undefined') {
    gOriginalsFolders = GetSelectedMsgFolders();
    gOriginalsFolderUris = new Object;
    for(var i = 0; i < gOriginalsFolders.length; i++) {
      gOriginalsFolderUris[gOriginalsFolders[i].URI] = true;
    }
    return;
  }
  
  // at this point we assume the gFolderTreeView object exists,
  // i.e. we can set custom properties for folders in the tree
  
  var selection = gFolderTreeView._treeElement.view.selection;
  var rangeCount = selection.getRangeCount();
  var numSelectedFolders = 0;
  gOriginalsFolders = new Array;
  gOriginalsFolderUris = new Object;
  var skippingSpecialFolders = 
    gRemoveDupesPrefs.getBoolPref('skip_special_folders','true');
  for (var i = 0; i < rangeCount; i++) {
    let startIndex = {};
    let endIndex = {};
    selection.getRangeAt(i, startIndex, endIndex);
    for (let j = startIndex.value; j <= endIndex.value; j++) {
      if (j >= gFolderTreeView._rowMap.length)
        break;
        
      var folder = gFolderTreeView._rowMap[j]._folder;
      if (skippingSpecialFolders) {
        if (!folder.canFileMessages ||
            (folder.rootFolder == folder) ||
            (!folder.canRename && 
            (!(folder.flags & gInboxFolderFlag)))) {
          alert(gRemoveDupesStrings.GetStringFromName("removedupes.invalid_originals_folders"));
          continue;
        }
      }
      gOriginalsFolders.push(folder);
      gOriginalsFolderUris[folder.URI] = true;
    }
  }
  gFolderTreeView._tree.invalidate();
  
  // TODO: Think of what happens if the user first marks the originals folders,
  // then changes the special folder skipping prefs; if we could clear the originals
  // in that case somehow...
}

#ifdef DEBUG_secondMenuItem

function secondMenuItem()
{
/*  stime = (new Date()).getTime();
  alert("hello, world!");
  etime = (new Date()).getTime();
  alert("it was " + (etime - stime) + " miliseconds");*/

 // example taken from http://forums.mozillazine.org/viewtopic.php?t=214824
  var content = "";
  var MessageURI = GetFirstSelectedMessage();
  var MsgService = messenger.messageServiceFromURI(MessageURI);
  var MsgStream =  Components.classes["@mozilla.org/network/sync-stream-listener;1"].createInstance();
  var consumer = MsgStream.QueryInterface(Components.interfaces.nsIInputStream);
  var ScriptInput = Components.classes["@mozilla.org/scriptableinputstream;1"].createInstance();
  var ScriptInputStream = ScriptInput.QueryInterface(Components.interfaces.nsIScriptableInputStream);
  ScriptInputStream.init(consumer);
  try {
    MsgService.streamMessage(MessageURI, MsgStream, msgWindow, null, false, null);
  } catch (ex) {
    alert("error: "+ex)
  }
  ScriptInputStream .available();
  while (ScriptInputStream .available()) {
    content = content + ScriptInputStream .read(512);
  }
  //alert(content);
  //jsConsoleService.logStringMessage('content of current selected message:\n\n' + content);
/*  var lines = content.split('\n');
  var i = 1;
  for (i = 0; i < lines.length; i++) {
    jsConsoleService.logStringMessage('line ' + i + ' | length ' + lines[i].length + ' | ' + string2hex(lines[i]));
  } */
  jsConsoleService.logStringMessage('content of current selected message after headers:\n\n' + content.split('\r\n\r\n')[1]);

}
#endif
